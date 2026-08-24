import { extractPdfText, splitReferences } from './pdf-text.js';
import { buildChunks, translateDocument } from './translator.js';
import { getDocumentPolicy, MAX_BODY_CHARS } from './document-policy.js';
import { terminateOcr } from './ocr.js';
import { createResultsZip, createTranslationPdf, downloadBlob } from './export.js';
import { clearQueue, deleteItem, hasStorageFor, loadQueue, saveItem } from './queue-store.js';

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_FILES = 20;
const MAX_RETRIES = 2;
const ACTIVE = new Set(['extract', 'ocr', 'glossary', 'draft', 'review', 'pdf']);
const LABELS = { queued:'대기', extract:'텍스트 추출', ocr:'OCR', glossary:'용어집', draft:'1차 번역', review:'교차검증', pdf:'PDF 생성', completed:'완료', failed:'실패', cancelled:'취소' };
const PHASE_RANGE = { extract:[0,15], ocr:[0,15], glossary:[15,25], draft:[25,70], review:[70,95], pdf:[95,100] };
const $ = (id) => document.getElementById(id);
const el = { input:$('fileInput'), drop:$('dropzone'), message:$('message'), start:$('startButton'), pause:$('pauseButton'), cancel:$('cancelButton'), zip:$('zipButton'), clear:$('clearButton'), list:$('queueList'), count:$('queueCount'), size:$('queueSize'), done:$('queueDone'), progress:$('progress'), label:$('progressLabel'), percent:$('progressPercent'), bar:$('progressBar'), result:$('result'), resultTitle:$('resultTitle'), translation:$('translation'), currentSave:$('currentSave') };

let queue = [];
let running = false;
let paused = false;
let controller = null;
let currentId = null;
let previewId = null;
const discardedIds = new Set();

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const baseName = (name) => name.replace(/\.pdf$/i, '');
const formatSize = (bytes) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
const totalBytes = () => queue.reduce((sum, item) => sum + (item.size || 0), 0);
const itemById = (id) => queue.find((item) => item.id === id);

function setMessage(text, kind = '') { el.message.textContent = text; el.message.classList.toggle('ok', kind === 'ok'); }

function renderMarkdown(markdown) {
  return String(markdown).split(/\n{2,}/).map((block) => block.trim()).filter(Boolean)
    .map((block) => block.startsWith('## ') ? `<h3>${escapeHtml(block.slice(3))}</h3>` : `<p>${escapeHtml(block)}</p>`).join('');
}

function phaseProgress(phase, done = 0, total = 1) {
  const [from, to] = PHASE_RANGE[phase] || [0, 0];
  return Math.round(from + (to - from) * Math.min(1, total ? done / total : 0));
}

function render() {
  el.count.textContent = `${queue.length}/${MAX_FILES}`;
  el.size.textContent = `${(totalBytes() / 1024 / 1024).toFixed(1)} / 500 MB`;
  el.done.textContent = `완료 ${queue.filter((i) => i.status === 'completed').length}`;
  el.start.disabled = !queue.some((i) => i.status === 'queued') || running;
  el.pause.disabled = !running;
  el.pause.textContent = paused ? '계속 실행' : '일시정지';
  el.cancel.disabled = !running && !queue.some((i) => i.status === 'queued');
  el.zip.disabled = !queue.some((i) => i.pdfBlob);
  el.clear.disabled = !queue.length;
  if (!queue.length) { el.list.innerHTML = '<div class="empty">등록된 PDF가 없습니다.</div>'; return; }
  el.list.innerHTML = queue.map((item) => {
    const tools = [];
    if (item.pdfBlob) tools.push(`<button class="mini" data-action="save" data-id="${item.id}">PDF 저장</button>`);
    if (item.status === 'failed' || item.status === 'cancelled') tools.push(`<button class="mini" data-action="retry" data-id="${item.id}">재시도</button>`);
    tools.push(`<button class="mini" data-action="delete" data-id="${item.id}">삭제</button>`);
    const mode = item.reviewMode === 'draft-only' ? ' · 1차 번역' : item.reviewMode === 'reviewed' ? ' · 교차검증' : '';
    return `<article class="queue-item ${ACTIVE.has(item.status) ? 'active' : ''} ${item.status === 'failed' ? 'failed' : ''}">
      <div class="item-top"><span class="item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><span class="item-status">${LABELS[item.status] || item.status}${mode}${item.attempt ? ` · ${item.attempt}차` : ''}</span></div>
      <div class="item-bar"><div style="width:${item.progress || 0}%"></div></div>
      ${item.error ? `<div class="item-error">${escapeHtml(item.error)}</div>` : ''}<div class="item-tools">${tools.join('')}</div></article>`;
  }).join('');
}

async function persist(item) {
  if (discardedIds.has(item.id)) return;
  try { await saveItem(item); }
  catch (error) { setMessage(`브라우저 저장 공간에 작업을 보존하지 못했습니다: ${error.message}`); }
}

async function addFiles(fileList) {
  const files = [...fileList];
  const messages = [];
  for (const file of files) {
    if (queue.length >= MAX_FILES) { messages.push('파일은 최대 20개까지 등록할 수 있습니다.'); break; }
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { messages.push(`${file.name}: PDF만 등록할 수 있습니다.`); continue; }
    if (file.size > MAX_FILE_BYTES) { messages.push(`${file.name}: 100MB를 초과합니다.`); continue; }
    if (totalBytes() + file.size > MAX_TOTAL_BYTES) { messages.push(`${file.name}: 전체 500MB 제한을 초과합니다.`); continue; }
    if (!(await hasStorageFor(file.size))) { messages.push(`${file.name}: 브라우저 저장 공간이 부족합니다.`); continue; }
    const item = { id: crypto.randomUUID(), order: Date.now() + queue.length, name:file.name, size:file.size, file, status:'queued', phase:'queued', progress:0, attempt:0, error:'', pdfBlob:null, outputName:`${baseName(file.name)}-ko.pdf`, pageMeta:[], warnings:[], bodyChars:0, chunks:0, reviewMode:'' };
    queue.push(item);
    await persist(item);
  }
  setMessage(messages.join(' '), messages.length ? '' : 'ok');
  render();
  el.input.value = '';
}

async function updateItem(item, changes, save = true) {
  Object.assign(item, changes);
  render();
  if (save) await persist(item);
}

async function processFile(item) {
  controller = new AbortController();
  currentId = item.id;
  let currentPhase = 'extract';
  await updateItem(item, { status:'extract', phase:'extract', progress:0, error:'', attempt:item.attempt + 1 });
  const showProgress = (phase, done = 0, total = 1, detail = '') => {
    currentPhase = phase;
    item.status = phase;
    item.phase = phase;
    item.progress = phaseProgress(phase, done, total);
    el.progress.classList.add('show');
    el.label.textContent = `${item.name} · ${LABELS[phase]}${detail ? ` · ${detail}` : ''}`;
    el.percent.textContent = `${item.progress}%`;
    el.bar.style.width = `${item.progress}%`;
    render();
  };
  try {
    const extracted = await extractPdfText(await item.file.arrayBuffer(), {
      signal:controller.signal,
      onPhase:(phase) => showProgress(phase, 0, 1),
      onProgress:(done, total, meta) => showProgress(meta?.source === 'ocr' ? 'ocr' : currentPhase, done, total, `${Math.min(total, Math.ceil(done))}/${total}페이지`),
    });
    item.pageMeta = extracted.pageMeta;
    item.warnings = extracted.warnings;
    const document_ = splitReferences(extracted.text);
    if (document_.body.length < 200) throw new Error('번역할 본문이 200자 미만입니다. 스캔 품질을 확인해주세요.');
    const policy = getDocumentPolicy(document_.body.length);
    if (!policy.allowed) throw new Error(`참고문헌을 제외한 본문이 최대 ${MAX_BODY_CHARS.toLocaleString()}자를 초과합니다. 장이나 파일을 나눠주세요.`);
    const chunks = buildChunks(document_.body).length;
    await updateItem(item, { bodyChars:policy.bodyChars, chunks, reviewMode:policy.mode });
    const modeText = policy.review ? '1차 번역과 2차 교차검증' : '장문 문서이므로 1차 번역만';
    setMessage(`${item.name}: 본문 ${policy.bodyChars.toLocaleString()}자 · 약 ${chunks}구간 · ${modeText} 수행합니다.`, 'ok');
    const result = await translateDocument(document_, {
      signal:controller.signal,
      review:policy.review,
      onPhase:(phase) => showProgress(phase, 0, 1),
      onProgress:(done, total) => showProgress(currentPhase, done, total, `${done}/${total}구간`),
      onPartial:(partial) => { previewId = item.id; el.result.classList.add('show'); el.resultTitle.textContent = `${baseName(item.name)} · 번역 중`; el.translation.innerHTML = renderMarkdown(partial); },
    });
    showProgress('pdf', 0, 1);
    const notice = policy.review ? '' : '장문 문서로 분류되어 1차 번역만 수행한 결과입니다.';
    const pdfBlob = await createTranslationPdf({ title:baseName(item.name), translation:result.translation, notice });
    item.pdfBlob = pdfBlob;
    await updateItem(item, { status:'completed', phase:'completed', progress:100, error:'' });
    previewId = item.id;
    el.result.classList.add('show'); el.resultTitle.textContent = `${baseName(item.name)} · 번역 결과`; el.translation.innerHTML = renderMarkdown(result.translation);
    downloadBlob(item.outputName, pdfBlob);
    setMessage(`${item.name} ${policy.review ? '번역·교차검증' : '1차 번역'}과 PDF 생성을 완료했습니다. 자동 저장이 보이지 않으면 작업 목록의 PDF 저장을 누르세요.`, 'ok');
  } finally {
    controller = null;
    currentId = null;
  }
}

async function runQueue() {
  if (running) { paused = false; render(); return; }
  running = true; paused = false; render();
  try {
    while (!paused) {
      const item = queue.find((candidate) => candidate.status === 'queued');
      if (!item) break;
      let complete = false;
      while (!complete && item.attempt <= MAX_RETRIES) {
        try { await processFile(item); complete = true; }
        catch (error) {
          if (error.name === 'AbortError') { await updateItem(item, { status:'cancelled', phase:'cancelled', error:'작업을 취소했습니다.' }); complete = true; }
          else if (error.fatal || item.attempt > MAX_RETRIES) { await updateItem(item, { status:'failed', phase:'failed', error:error.message || '처리 중 오류가 발생했습니다.' }); complete = true; }
          else { await updateItem(item, { status:'queued', phase:'queued', progress:0, error:`일시적 오류로 재시도합니다: ${error.message}` }); }
        }
      }
    }
  } finally {
    running = false;
    await terminateOcr();
    if (!queue.some((i) => ACTIVE.has(i.status))) el.progress.classList.remove('show');
    render();
  }
}

async function cancelAll() {
  controller?.abort();
  for (const item of queue.filter((i) => i.status === 'queued')) await updateItem(item, { status:'cancelled', phase:'cancelled', error:'전체 작업을 취소했습니다.' });
}

async function removeItem(id) {
  discardedIds.add(id);
  if (currentId === id) controller?.abort();
  queue = queue.filter((item) => item.id !== id);
  await deleteItem(id);
  if (previewId === id) { previewId = null; el.result.classList.remove('show'); }
  render();
}

el.input.addEventListener('change', (event) => addFiles(event.target.files));
['dragenter','dragover'].forEach((type) => el.drop.addEventListener(type, (event) => { event.preventDefault(); el.drop.classList.add('dragover'); }));
['dragleave','drop'].forEach((type) => el.drop.addEventListener(type, (event) => { event.preventDefault(); el.drop.classList.remove('dragover'); }));
el.drop.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
el.start.addEventListener('click', () => runQueue());
el.pause.addEventListener('click', () => { paused = !paused; if (!paused && !running) runQueue(); render(); });
el.cancel.addEventListener('click', cancelAll);
el.clear.addEventListener('click', async () => {
  queue.forEach((item) => discardedIds.add(item.id));
  controller?.abort(); queue = []; await clearQueue(); previewId = null; el.result.classList.remove('show'); render();
});
el.zip.addEventListener('click', async () => {
  const completed = queue.filter((item) => item.pdfBlob);
  if (!completed.length) return;
  setMessage('완료된 PDF를 ZIP으로 묶는 중입니다.');
  const blob = await createResultsZip(completed);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadBlob(`${stamp}-paperflow-translations.zip`, blob);
  setMessage(`${completed.length}개 PDF를 ZIP으로 만들었습니다.`, 'ok');
});
el.currentSave.addEventListener('click', () => { const item = itemById(previewId); if (item?.pdfBlob) downloadBlob(item.outputName, item.pdfBlob); });
el.list.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const item = itemById(button.dataset.id); if (!item) return;
  if (button.dataset.action === 'save' && item.pdfBlob) downloadBlob(item.outputName, item.pdfBlob);
  if (button.dataset.action === 'retry') { await updateItem(item, { status:'queued', phase:'queued', progress:0, attempt:0, error:'' }); }
  if (button.dataset.action === 'delete') await removeItem(item.id);
});

(async () => {
  try {
    queue = await loadQueue();
    for (const item of queue.filter((i) => i.recovered)) { delete item.recovered; await persist(item); }
    if (queue.length) setMessage('이전 작업 목록을 복구했습니다. 미완료 파일은 다시 시작할 수 있습니다.', 'ok');
  } catch (error) { setMessage(`작업 목록을 복구하지 못했습니다: ${error.message}`); }
  render();
})();
