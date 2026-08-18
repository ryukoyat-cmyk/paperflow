// Orchestrates the translation from the browser.
//
// The work is driven client-side, one bounded model call per request, because a
// Netlify function has a short wall-clock budget. Each request is a pure
// function of its input, so any chunk can be retried — or split and retried —
// without corrupting the document.

const ENDPOINT = '/.netlify/functions/translate';

const CHUNK_TARGET = 3500;   // characters of English per model call
const GLOSSARY_SAMPLE = 20000;
const CONCURRENCY = 3;
const REVIEW_DEADLINE_MS = 8 * 60 * 1000;

class TruncatedError extends Error {}

async function runTask(payload, { onDelta, signal } = {}) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    let message = `서버 오류 (${response.status})`;
    try {
      message = (await response.json()).error || message;
    } catch { /* keep default */ }
    const error = new Error(message);
    error.status = response.status;
    // A bad key, a bad model or a rejected payload will fail identically on every
    // retry, so these must not be retried or split — that multiplies one config
    // mistake into dozens of requests.
    error.fatal = [400, 401, 403, 404, 500].includes(response.status);
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let failure = null;

  const consume = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === 'delta') {
      text += event.text;
      onDelta?.(event.text);
    } else if (event.type === 'error') {
      failure = event;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      consume(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  }
  consume(buffer);

  if (failure) {
    if (failure.code === 'truncated') throw new TruncatedError(failure.message);
    throw new Error(failure.message || '번역에 실패했습니다.');
  }
  if (!text.trim()) throw new Error('빈 번역 결과를 받았습니다.');
  return text;
}

/** Packs paragraphs into chunks without ever splitting a paragraph. */
export function buildChunks(body, target = CHUNK_TARGET) {
  const paragraphs = body.split('\n\n').map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = [];
  let size = 0;

  for (const paragraph of paragraphs) {
    // A heading belongs with the text it introduces, never stranded at a chunk end.
    const isHeading = paragraph.startsWith('## ');
    if (size && size + paragraph.length > target && !(isHeading && size + paragraph.length < target * 1.3)) {
      chunks.push(current.join('\n\n'));
      current = [];
      size = 0;
    }
    current.push(paragraph);
    size += paragraph.length + 2;
  }
  if (current.length) chunks.push(current.join('\n\n'));
  return chunks;
}

function splitChunk(chunk) {
  const paragraphs = chunk.split('\n\n');
  if (paragraphs.length < 2) {
    const mid = Math.floor(chunk.length / 2);
    const at = chunk.indexOf(' ', mid);
    return at === -1 ? [chunk] : [chunk.slice(0, at), chunk.slice(at + 1)];
  }
  const mid = Math.ceil(paragraphs.length / 2);
  return [paragraphs.slice(0, mid).join('\n\n'), paragraphs.slice(mid).join('\n\n')];
}

/** The abstract, opening sections and every heading — enough to fix terminology. */
function glossarySample(body) {
  const paragraphs = body.split('\n\n');
  const headings = paragraphs.filter((p) => p.startsWith('## ')).join('\n');
  const opening = paragraphs.slice(0, 24).join('\n\n');
  return `${headings}\n\n${opening}`.slice(0, GLOSSARY_SAMPLE);
}

async function buildGlossary(body, signal) {
  try {
    const raw = await runTask({ task: 'glossary', text: glossarySample(body) }, { signal });
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed.terms)) return [];
    return parsed.terms
      .filter((t) => t && typeof t.en === 'string' && typeof t.ko === 'string' && t.en.trim() && t.ko.trim())
      .slice(0, 60);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    // A missing glossary costs consistency, not correctness — keep going.
    return [];
  }
}

// Attempts one chunk. Only a truncated response is worth splitting: it is the
// one failure that a smaller input actually fixes.
async function translateChunk(spec, { signal, depth = 0 }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await runTask(spec, { signal });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      lastError = error;
      if (error.fatal || error instanceof TruncatedError) break;
      await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
    }
  }

  if (!(lastError instanceof TruncatedError) || depth >= 3) throw lastError;
  const halves = splitChunk(spec.text);
  if (halves.length < 2) throw lastError;
  const parts = [];
  for (const half of halves) {
    parts.push(await translateChunk({ ...spec, text: half }, { signal, depth: depth + 1 }));
  }
  return parts.join('\n\n');
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

const tail = (text, n = 500) => (text ? text.slice(-n) : '');

/**
 * @param {{body:string, references:string}} document
 * @param {{onPhase?:Function, onProgress?:Function, onPartial?:Function, signal?:AbortSignal}} hooks
 */
export async function translateDocument(document, hooks = {}) {
  const { onPhase, onProgress, onPartial, signal } = hooks;
  const started = Date.now();

  onPhase?.('glossary');
  const glossary = await buildGlossary(document.body, signal);

  const chunks = buildChunks(document.body);
  if (!chunks.length) throw new Error('번역할 본문을 찾지 못했습니다.');

  onPhase?.('draft');
  let completed = 0;
  const drafts = new Array(chunks.length);

  await pool(chunks, CONCURRENCY, async (chunk, index) => {
    const previous = index > 0
      ? { source: tail(chunks[index - 1]), target: tail(drafts[index - 1]) }
      : null;
    const result = await translateChunk(
      { task: 'draft', text: chunk, glossary, context: previous },
      { signal },
    );
    drafts[index] = result;
    completed += 1;
    onProgress?.(completed, chunks.length);
    onPartial?.(drafts.filter(Boolean).join('\n\n'));
    return result;
  });

  onPhase?.('review');
  let reviewed = 0;
  let skippedReview = 0;
  const finals = await pool(chunks, CONCURRENCY, async (chunk, index) => {
    // Long documents keep the verified draft rather than stalling at the deadline.
    if (Date.now() - started > REVIEW_DEADLINE_MS) {
      skippedReview += 1;
      reviewed += 1;
      onProgress?.(reviewed, chunks.length);
      return drafts[index];
    }
    let result = drafts[index];
    try {
      result = await translateChunk(
        { task: 'review', text: chunk, draft: drafts[index], glossary },
        { signal },
      );
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      skippedReview += 1;   // keep the draft; a failed review must not lose work
    }
    reviewed += 1;
    onProgress?.(reviewed, chunks.length);
    return result;
  });

  return {
    translation: finals.join('\n\n'),
    references: document.references,
    glossary,
    chunks: chunks.length,
    skippedReview,
    elapsedMs: Date.now() - started,
  };
}
