// PDF -> clean plain text, in the browser.
//
// Runs in the browser on purpose. Netlify caps a function request body at 6 MB,
// so a real paper can never be uploaded to a function; extracting here means
// only the text (a few tens of KB) ever crosses the wire. It also removes the
// `pdf-parse` dependency, whose debug branch breaks once esbuild bundles it.

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { canvasHasInk, recognisePage } from './ocr.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// Two-column papers are the norm, and reading items in raw order interleaves the
// columns into nonsense. Treat a page as two-column only when both halves are
// busy and almost nothing straddles the middle (a straddling line is a title,
// a full-width figure or a table).
function detectColumnSplit(items, pageWidth) {
  const mid = pageWidth / 2;
  let left = 0, right = 0, straddling = 0;
  for (const it of items) {
    if (it.x + it.width < mid) left += 1;
    else if (it.x > mid) right += 1;
    else straddling += 1;
  }
  const sided = left + right;
  if (sided < 12) return null;
  if (left / sided < 0.25 || right / sided < 0.25) return null;
  if (straddling / items.length > 0.18) return null;
  return mid;
}

// Group items sharing a baseline into lines, keeping the geometry and font size,
// because paragraph breaks and headings can only be recovered from those.
function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str.trim()) continue;
    const tolerance = Math.max(2, it.height * 0.5);
    const row = rows.find((r) => Math.abs(r.y - it.y) <= tolerance);
    if (row) {
      row.items.push(it);
      row.y = (row.y * (row.items.length - 1) + it.y) / row.items.length;
    } else {
      rows.push({ y: it.y, items: [it] });
    }
  }
  rows.sort((a, b) => b.y - a.y);

  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x);
    let text = '';
    let previous = null;
    for (const it of row.items) {
      if (previous) {
        const gap = it.x - (previous.x + previous.width);
        // pdf.js emits kerned runs as separate items; only a real gap is a space.
        if (gap > Math.max(1, it.height * 0.18) && !/\s$/.test(text)) text += ' ';
      }
      text += it.str;
      previous = it;
    }
    const last = row.items[row.items.length - 1];
    return {
      text: text.replace(/\s+/g, ' ').trim(),
      x0: row.items[0].x,
      x1: last.x + last.width,
      size: median(row.items.map((it) => it.height)),
    };
  }).filter((line) => line.text);
}

// Each line carries the bounds of the column it sits in, so indentation can be
// measured against the right margin even on mixed-layout pages.
function withColumnBounds(lines) {
  if (!lines.length) return [];
  const starts = lines.map((l) => l.x0).sort((a, b) => a - b);
  const ends = lines.map((l) => l.x1).sort((a, b) => a - b);
  const colLeft = starts[Math.floor(starts.length * 0.1)];
  const colRight = ends[Math.floor(ends.length * 0.9)];
  return lines.map((line) => ({ ...line, colLeft, colRight }));
}

function textQuality(lines) {
  const text = lines.map((line) => line.text).join(' ').trim();
  const valid = (text.match(/[A-Za-z0-9]/g) || []).length;
  return { chars: text.length, ratio: text.length ? valid / text.length : 0 };
}

async function renderForOcr(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, 3000 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}

async function pageLines(page, { signal, onPhase, onOcrProgress } = {}) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = content.items
    .filter((it) => typeof it.str === 'string')
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      width: it.width || 0,
      height: Math.abs(it.transform[3]) || it.height || 10,
    }));
  let textLines = [];
  if (items.length) {
    const split = detectColumnSplit(items, viewport.width);
    if (split === null) textLines = withColumnBounds(itemsToLines(items));
    else {
      const spanning = items.filter((it) => it.x < split && it.x + it.width > split);
      const left = items.filter((it) => it.x + it.width <= split);
      const right = items.filter((it) => it.x >= split);
      textLines = [
        ...withColumnBounds(itemsToLines(spanning)),
        ...withColumnBounds(itemsToLines(left)),
        ...withColumnBounds(itemsToLines(right)),
      ];
    }
  }
  const quality = textQuality(textLines);
  if (quality.chars >= 40 && quality.ratio >= 0.6) return { lines: textLines, source: 'text', chars: quality.chars };

  if (signal?.aborted) throw new DOMException('텍스트 추출을 취소했습니다.', 'AbortError');
  const canvas = await renderForOcr(page);
  try {
    if (!canvasHasInk(canvas)) return { lines: textLines, source: 'text', chars: quality.chars, warning: '빈 페이지로 판단해 OCR을 건너뛰었습니다.' };
    onPhase?.('ocr');
    const ocrLines = withColumnBounds(await recognisePage(canvas, { signal, onProgress: onOcrProgress }));
    const ocrQuality = textQuality(ocrLines);
    if (ocrQuality.chars > quality.chars && ocrQuality.ratio >= 0.45) {
      return { lines: ocrLines, source: 'ocr', chars: ocrQuality.chars };
    }
    return { lines: textLines, source: 'text', chars: quality.chars, warning: 'OCR 결과가 기존 텍스트보다 좋지 않아 원본 추출을 유지했습니다.' };
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

// A running head or footer repeats across pages; a page number is bare digits.
function dropRepeatedFurniture(pages) {
  const seen = new Map();
  const edgeOf = (lines) => [...lines.slice(0, 2), ...lines.slice(-2)];
  for (const lines of pages) {
    for (const line of new Set(edgeOf(lines))) {
      const key = line.text.replace(/\d+/g, '#').toLowerCase();
      if (key.length < 4) continue;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.4));
  const isFurniture = (line, index, total) => {
    if (/^[ivxlcdm]{1,7}$/i.test(line.text)) return true;             // roman page number
    if (/^[-–—\s]*\d{1,4}[-–—\s]*$/.test(line.text)) return true;      // arabic page number
    if (index > 1 && index < total - 2) return false;
    const key = line.text.replace(/\d+/g, '#').toLowerCase();
    return key.length >= 4 && (seen.get(key) || 0) >= threshold;
  };
  return pages.map((lines) => lines.filter((line, i) => !isFurniture(line, i, lines.length)));
}

const LIGATURES = { 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'ft', 'ﬆ': 'st' };

function normalise(text) {
  return text
    .replace(/[ﬁﬂﬀﬃﬄﬅﬆ]/g, (c) => LIGATURES[c])
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/­/g, '')        // soft hyphen
    .replace(/[‐‑]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\f/g, ' ')
    .normalize('NFC');
}

const HEADING_WORDS =
  /^(abstract|introduction|background|related work|preliminaries|method(s|ology)?|approach|experiments?|experimental setup|evaluation|results?( and discussion)?|analysis|ablation( study| studies)?|discussion|limitations?|conclusions?( and future work)?|future work|acknowledgements?|acknowledgments?|references|bibliography|appendix( ?[a-z0-9]+)?|supplementary material)\s*$/i;

const NUMBERED_HEADING = /^(\d+(\.\d+)*|[IVXLC]+|[A-Z])\.?\s+\S/;

function isHeadingLine(line, bodySize) {
  const text = line.text;
  if (text.length > 120) return false;
  const stripped = text.replace(NUMBERED_HEADING, (m) => m.replace(/^\S+\s+/, ''));
  if (HEADING_WORDS.test(text) || HEADING_WORDS.test(stripped)) return true;
  if (NUMBERED_HEADING.test(text) && !/[.?!;,]$/.test(text) && text.length < 90) return true;
  // A short line set noticeably larger than the body is a heading or the title.
  // Font size is the reliable signal; matching on capitalisation alone turns a
  // wrapped title into a spurious heading.
  if (bodySize && line.size > bodySize * 1.1 && text.length < 100 && !/[.?!,;]$/.test(text)) return true;
  return false;
}

const ENDS_SENTENCE = /[.!?:"')\]]\s*$/;

// Reflows hard-wrapped lines into paragraphs. Two signals recover the breaks:
// a first-line indent, or a previous line that stopped short of the right margin.
function linesToBlocks(lines, bodySize, indentMode) {
  const blocks = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    blocks.push({ kind: current.kind, parts: current.parts });
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const previous = i > 0 ? lines[i - 1] : null;
    const kind = isHeadingLine(line, bodySize) ? 'heading' : 'body';
    const width = Math.max(1, line.colRight - line.colLeft);

    let breakHere = !current || current.kind !== kind;
    // A change of font size is a change of role: running head, title, body.
    if (!breakHere && Math.abs(line.size - current.size) / current.size > 0.06) breakHere = true;
    // Indentation and short-line tests only apply to running text. Headings and
    // titles are frequently centred, which would otherwise read as an indent.
    if (!breakHere && kind === 'body') {
      if (indentMode && line.x0 > line.colLeft + Math.max(4, width * 0.02)) breakHere = true;
      else if (!indentMode && previous
          && previous.x1 < previous.colRight - width * 0.08
          && ENDS_SENTENCE.test(previous.text)) breakHere = true;
    }

    if (breakHere) {
      flush();
      current = { kind, size: line.size, parts: [line.text] };
      continue;
    }

    const soFar = current.parts[current.parts.length - 1];
    if (/[A-Za-zÀ-ɏ]-$/.test(soFar) && /^[a-z]/.test(line.text)) {
      // "trans-" + "lation": a line-break hyphen from justification. Keep it only
      // when the joined form appears hyphenated elsewhere in the document.
      current.parts.push({ hyphen: true, text: line.text });
    } else {
      current.parts.push(` ${line.text}`);
    }
  }
  flush();
  return blocks;
}

// Resolving line-break hyphens needs the whole document: a hyphen that also
// occurs mid-line elsewhere is part of the word, not an artefact of wrapping.
function collectHyphenatedWords(lines) {
  const set = new Set();
  for (const line of lines) {
    for (const match of line.text.matchAll(/\b([A-Za-z]{2,})-([A-Za-z]{2,})\b/g)) {
      set.add(`${match[1].toLowerCase()}-${match[2].toLowerCase()}`);
    }
  }
  return set;
}

function joinParts(parts, hyphenated) {
  let text = '';
  for (const part of parts) {
    if (typeof part === 'string') { text += part; continue; }
    const left = text.match(/([A-Za-zÀ-ɏ]+)-$/);
    const right = part.text.match(/^([a-zÀ-ɏ]+)/);
    const compound = left && right ? `${left[1].toLowerCase()}-${right[1].toLowerCase()}` : null;
    text = compound && hyphenated.has(compound) ? text + part.text : text.slice(0, -1) + part.text;
  }
  return text;
}

// Long paragraphs are broken at sentence boundaries so a chunk edge never lands
// mid-sentence.
function splitLongParagraphs(paragraphs) {
  const out = [];
  for (const p of paragraphs) {
    if (p.startsWith('## ') || p.length < 1200) { out.push(p); continue; }
    const sentences = p.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [p];
    let buffer = '';
    for (const sentence of sentences) {
      if (buffer && buffer.length + sentence.length > 900) { out.push(buffer.trim()); buffer = ''; }
      buffer += sentence;
    }
    if (buffer.trim()) out.push(buffer.trim());
  }
  return out;
}

/**
 * @param {ArrayBuffer} data raw PDF bytes
 * @param {{signal?:AbortSignal,onProgress?:Function,onPhase?:Function}|Function} [options]
 * @returns {Promise<{text:string,pages:number,chars:number,pageMeta:Array,warnings:Array}>}
 */
export async function extractPdfText(data, options = {}) {
  const { signal, onProgress, onPhase } = typeof options === 'function'
    ? { onProgress: options }
    : options;
  const loadingTask = pdfjs.getDocument({
    data,
    // Papers routinely embed CJK/maths fonts; without these pdf.js drops glyphs.
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;

  const pages = [];
  const pageMeta = [];
  const warnings = [];
  try {
    for (let n = 1; n <= doc.numPages; n += 1) {
      if (signal?.aborted) throw new DOMException('텍스트 추출을 취소했습니다.', 'AbortError');
      const page = await doc.getPage(n);
      try {
        onPhase?.('extract');
        const result = await pageLines(page, {
          signal,
          onPhase,
          onOcrProgress: (event) => onProgress?.(n - 1 + (event.progress || 0), doc.numPages, { page: n, source: 'ocr' }),
        });
        pages.push(result.lines);
        pageMeta.push({ page: n, source: result.source, chars: result.chars });
        if (result.warning) warnings.push(`페이지 ${n}: ${result.warning}`);
      } finally {
        page.cleanup();
      }
      onProgress?.(n, doc.numPages, pageMeta[pageMeta.length - 1]);
    }
  } finally {
    await loadingTask.destroy();
  }

  const lines = dropRepeatedFurniture(pages)
    .flat()
    .map((line) => ({ ...line, text: normalise(line.text) }))
    .filter((line) => line.text);
  if (!lines.length) return { text: '', pages: doc.numPages, chars: 0, pageMeta, warnings };

  // Body size is the size most of the text is set in, weighted by how much text
  // each line carries, so headings and captions cannot skew it.
  const weighted = lines.flatMap((line) => Array(Math.max(1, Math.round(line.text.length / 10))).fill(line.size));
  const bodySize = median(weighted);

  const indented = lines.filter((line) => line.x0 > line.colLeft + Math.max(4, (line.colRight - line.colLeft) * 0.02));
  const indentMode = indented.length / lines.length >= 0.12;

  const hyphenated = collectHyphenatedWords(lines);
  const blocks = linesToBlocks(lines, bodySize, indentMode);
  const paragraphs = blocks
    .map((block) => {
      const text = joinParts(block.parts, hyphenated).replace(/\s+/g, ' ').trim();
      if (!text) return '';
      return block.kind === 'heading' ? `## ${text}` : text;
    })
    .filter(Boolean);

  const text = splitLongParagraphs(paragraphs).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, pages: doc.numPages, chars: text.length, pageMeta, warnings };
}

/** Splits off the reference list, which should be kept verbatim rather than translated. */
export function splitReferences(text) {
  const blocks = text.split('\n\n');
  for (let i = blocks.length - 1; i >= Math.floor(blocks.length * 0.4); i -= 1) {
    if (/^##\s*(\d+(\.\d+)*\.?\s*)?(references|bibliography)\b/i.test(blocks[i])) {
      return { body: blocks.slice(0, i).join('\n\n').trim(), references: blocks.slice(i).join('\n\n').trim() };
    }
  }
  return { body: text, references: '' };
}
