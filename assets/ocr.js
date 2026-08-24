const TESSERACT_ROOT = '../vendor/tesseract';

let apiPromise = null;
let workerPromise = null;
let progressListener = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`OCR 자산을 불러오지 못했습니다: ${src}`));
    document.head.appendChild(script);
  });
}

async function getApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      if (!globalThis.Tesseract) {
        await loadScript(new URL(`${TESSERACT_ROOT}/tesseract.min.js`, import.meta.url).href);
      }
      return globalThis.Tesseract;
    })();
  }
  return apiPromise;
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const Tesseract = await getApi();
      return Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
        workerPath: new URL(`${TESSERACT_ROOT}/worker.min.js`, import.meta.url).href,
        corePath: new URL(`${TESSERACT_ROOT}/`, import.meta.url).href,
        langPath: new URL(`${TESSERACT_ROOT}/lang`, import.meta.url).href,
        logger: (event) => progressListener?.(event),
      });
    })().catch((error) => { workerPromise = null; throw error; });
  }
  return workerPromise;
}

function collectLines(node, output = []) {
  if (!node || typeof node !== 'object') return output;
  if (Array.isArray(node.lines)) {
    for (const line of node.lines) {
      const text = String(line.text || '').replace(/\s+/g, ' ').trim();
      if (text && line.bbox) output.push({ text, bbox: line.bbox });
    }
  }
  for (const key of ['blocks', 'paragraphs']) {
    if (Array.isArray(node[key])) node[key].forEach((child) => collectLines(child, output));
  }
  return output;
}

function orderLines(lines, width) {
  const mid = width / 2;
  const left = lines.filter((l) => l.bbox.x1 <= mid);
  const right = lines.filter((l) => l.bbox.x0 >= mid);
  const spanning = lines.filter((l) => l.bbox.x0 < mid && l.bbox.x1 > mid);
  const sided = left.length + right.length;
  const twoColumn = sided >= 12
    && left.length / sided >= 0.25
    && right.length / sided >= 0.25
    && spanning.length / Math.max(1, lines.length) <= 0.18;
  const sort = (items) => [...items].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const ordered = twoColumn ? [...sort(spanning), ...sort(left), ...sort(right)] : sort(lines);
  return ordered.map((line) => ({
    text: line.text,
    x0: line.bbox.x0,
    x1: line.bbox.x1,
    size: Math.max(8, line.bbox.y1 - line.bbox.y0),
  }));
}

export function canvasHasInk(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const step = Math.max(4, Math.floor(Math.max(canvas.width, canvas.height) / 180));
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = 0; y < canvas.height; y += step) {
    for (let x = 0; x < canvas.width; x += step) {
      const i = (y * canvas.width + x) * 4;
      const value = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum += value;
      sumSq += value * value;
      count += 1;
    }
  }
  const mean = sum / Math.max(1, count);
  return sumSq / Math.max(1, count) - mean * mean > 18;
}

export async function recognisePage(canvas, { signal, onProgress } = {}) {
  if (signal?.aborted) throw new DOMException('OCR을 취소했습니다.', 'AbortError');
  progressListener = onProgress || null;
  const worker = await getWorker();
  if (signal?.aborted) {
    await worker.terminate();
    workerPromise = null;
    throw new DOMException('OCR을 취소했습니다.', 'AbortError');
  }
  const abort = () => worker.terminate();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await worker.recognize(canvas, {}, { blocks: true, text: true });
    if (signal?.aborted) throw new DOMException('OCR을 취소했습니다.', 'AbortError');
    const lines = collectLines(result.data);
    if (lines.length) return orderLines(lines, canvas.width);
    return String(result.data.text || '').split(/\r?\n/).map((text) => text.trim()).filter(Boolean)
      .map((text) => ({ text, x0: 0, x1: canvas.width, size: 12 }));
  } finally {
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) workerPromise = null;
  }
}

export async function terminateOcr() {
  if (!workerPromise) return;
  try { (await workerPromise).terminate(); } finally { workerPromise = null; progressListener = null; }
}
