import { extractPdfText, splitReferences } from './pdf-text.js';
import { translateDocument } from './translator.js';

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_CHARS = 300000;

const $ = (id) => document.getElementById(id);
const el = {
  fileInput: $('fileInput'), dropzone: $('dropzone'), fileInfo: $('fileInfo'),
  fileName: $('fileName'), fileSize: $('fileSize'), message: $('message'),
  button: $('translateButton'), progress: $('progress'), label: $('progressLabel'),
  percent: $('progressPercent'), bar: $('progressBar'), result: $('result'),
  resultTitle: $('resultTitle'), translation: $('translation'),
  glossaryBox: $('glossaryBox'), glossaryBody: $('glossaryBody'),
  refsBox: $('refsBox'), refsBody: $('refsBody'),
  copy: $('copyButton'), download: $('downloadButton'), print: $('printButton'),
};

let selectedFile = null;
let controller = null;
let currentPhase = 'extract';
let output = { translation: '', references: '', name: 'translation' };

// Each phase owns a slice of the bar so the percentage never jumps backwards.
const PHASES = {
  extract:  { label: 'PDF에서 텍스트를 추출하는 중', from: 0,  to: 15 },
  glossary: { label: '핵심 용어집을 만드는 중',      from: 15, to: 25 },
  draft:    { label: 'AI가 1차 번역하는 중',         from: 25, to: 70 },
  review:   { label: 'AI가 교차검증하는 중',         from: 70, to: 99 },
};
const ORDER = Object.keys(PHASES);

function setMessage(text, kind) {
  el.message.textContent = text;
  el.message.classList.toggle('ok', kind === 'ok');
}

function setPhase(phase, done = 0, total = 1, detail = '') {
  const meta = PHASES[phase];
  if (!meta) return;
  currentPhase = phase;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const percent = Math.round(meta.from + (meta.to - meta.from) * ratio);
  el.label.textContent = meta.label;
  el.percent.textContent = `${percent}%`;
  el.bar.style.width = `${percent}%`;

  const index = ORDER.indexOf(phase);
  document.querySelectorAll('.step').forEach((step) => {
    const at = ORDER.indexOf(step.dataset.step);
    step.classList.toggle('active', at === index);
    step.classList.toggle('done', at < index);
  });
  const slot = document.querySelector(`[data-detail="${phase}"]`);
  if (slot) slot.textContent = detail;
}

function finishProgress() {
  el.label.textContent = '번역이 완료되었습니다';
  el.percent.textContent = '100%';
  el.bar.style.width = '100%';
  document.querySelectorAll('.step').forEach((s) => { s.classList.remove('active'); s.classList.add('done'); });
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function selectFile(file) {
  setMessage('');
  selectedFile = null;
  el.button.disabled = true;
  el.fileInfo.classList.remove('show');
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    setMessage('PDF 파일만 업로드할 수 있습니다.');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    setMessage('파일 크기는 최대 100MB까지 가능합니다.');
    return;
  }
  selectedFile = file;
  el.fileName.textContent = file.name;
  el.fileSize.textContent = formatSize(file.size);
  el.fileInfo.classList.add('show');
  el.button.disabled = false;
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// The model returns Markdown limited to '## ' headings and blank-line paragraphs,
// so a full Markdown parser would be dead weight here.
function renderMarkdown(markdown) {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => (block.startsWith('## ')
      ? `<h3>${escapeHtml(block.slice(3).trim())}</h3>`
      : `<p>${escapeHtml(block)}</p>`))
    .join('');
}

function showResult(result, baseName) {
  output = { translation: result.translation, references: result.references, name: baseName };
  el.translation.innerHTML = renderMarkdown(result.translation);

  if (result.glossary?.length) {
    el.glossaryBody.innerHTML = result.glossary
      .map((t) => `<tr><td>${escapeHtml(t.en)}</td><td>${escapeHtml(t.ko)}</td></tr>`)
      .join('');
    el.glossaryBox.hidden = false;
  } else {
    el.glossaryBox.hidden = true;
  }

  if (result.references) {
    el.refsBody.textContent = result.references;
    el.refsBox.hidden = false;
  } else {
    el.refsBox.hidden = true;
  }

  el.result.classList.add('show');
  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function markdownFile() {
  const parts = [`# ${output.name}`, '', output.translation];
  if (output.references) parts.push('', '## References (원문)', '', output.references);
  return parts.join('\n');
}

function download(filename, contents) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function run() {
  if (!selectedFile) return;
  const baseName = selectedFile.name.replace(/\.pdf$/i, '');

  controller = new AbortController();
  el.button.textContent = '취소';
  el.progress.classList.add('show');
  el.result.classList.remove('show');
  setMessage('');
  setPhase('extract', 0, 1);

  try {
    const buffer = await selectedFile.arrayBuffer();
    const extracted = await extractPdfText(buffer, (page, total) => {
      setPhase('extract', page, total, `${page}/${total} 페이지`);
    });

    if (extracted.chars < 200) {
      throw new Error('텍스트를 추출할 수 없는 PDF입니다. 스캔한 이미지 PDF는 아직 지원하지 않습니다.');
    }
    if (extracted.chars > MAX_CHARS) {
      throw new Error(`본문이 너무 깁니다. (${extracted.chars.toLocaleString()}자 / 최대 ${MAX_CHARS.toLocaleString()}자) 장을 나눠 올려주세요.`);
    }

    const document_ = splitReferences(extracted.text);
    setPhase('extract', 1, 1, `${extracted.pages}페이지 · ${extracted.chars.toLocaleString()}자`);

    const result = await translateDocument(document_, {
      signal: controller.signal,
      onPhase: (phase) => setPhase(phase, 0, 1),
      onProgress: (done, total) => setPhase(currentPhase, done, total, `${done}/${total} 구간`),
      onPartial: (partial) => {
        el.translation.innerHTML = renderMarkdown(partial);
        el.result.classList.add('show');
      },
    });

    finishProgress();
    showResult(result, baseName);
    const seconds = Math.round(result.elapsedMs / 1000);
    const note = result.skippedReview
      ? ` ${result.skippedReview}개 구간은 교차검증을 건너뛰고 1차 번역을 사용했습니다.`
      : '';
    setMessage(`${result.chunks}개 구간을 번역하고 교차검증했습니다. (${seconds}초)${note}`, 'ok');
    el.resultTitle.textContent = `${baseName} · 번역 결과`;
  } catch (error) {
    if (error.name === 'AbortError') {
      setMessage('번역을 취소했습니다.');
    } else {
      setMessage(error.message || '번역 중 오류가 발생했습니다.');
    }
    el.progress.classList.remove('show');
  } finally {
    controller = null;
    el.button.textContent = '번역 시작하기';
    el.button.disabled = !selectedFile;
  }
}

el.fileInput.addEventListener('change', (e) => selectFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((type) => el.dropzone.addEventListener(type, (e) => {
  e.preventDefault();
  el.dropzone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((type) => el.dropzone.addEventListener(type, (e) => {
  e.preventDefault();
  el.dropzone.classList.remove('dragover');
}));
el.dropzone.addEventListener('drop', (e) => selectFile(e.dataTransfer.files[0]));

el.button.addEventListener('click', () => {
  if (controller) {
    controller.abort();
    return;
  }
  run();
});

el.copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(output.translation);
    setMessage('번역문을 클립보드에 복사했습니다.', 'ok');
  } catch {
    setMessage('클립보드 복사에 실패했습니다. 직접 선택해 복사해주세요.');
  }
});
el.download.addEventListener('click', () => download(`${output.name}-ko.md`, markdownFile()));
el.print.addEventListener('click', () => window.print());
