const loaded = new Map();

function loadScript(path) {
  const url = new URL(path, import.meta.url).href;
  if (!loaded.has(url)) loaded.set(url, new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`내보내기 자산을 불러오지 못했습니다: ${path}`));
    document.head.appendChild(script);
  }));
  return loaded.get(url);
}

async function loadPdfTools() {
  await loadScript('../vendor/pdf-lib/pdf-lib.min.js');
  await loadScript('../vendor/pdf-lib/fontkit.umd.min.js');
  return { PDFLib: globalThis.PDFLib, fontkit: globalThis.fontkit };
}

async function bytes(path) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error(`폰트를 불러오지 못했습니다. (${response.status})`);
  return response.arrayBuffer();
}

function wrapText(text, font, size, width) {
  const tokens = text.match(/\S+\s*|\s+/g) || [''];
  const lines = [];
  let line = '';
  const push = () => { if (line.trim()) lines.push(line.trimEnd()); line = ''; };
  for (const token of tokens) {
    const candidate = line + token;
    if (!line || font.widthOfTextAtSize(candidate, size) <= width) { line = candidate; continue; }
    push();
    if (font.widthOfTextAtSize(token, size) <= width) { line = token.trimStart(); continue; }
    for (const char of token) {
      if (font.widthOfTextAtSize(line + char, size) > width) push();
      line += char;
    }
  }
  push();
  return lines.length ? lines : [''];
}

export async function createTranslationPdf({ title, translation }) {
  const { PDFLib, fontkit } = await loadPdfTools();
  const [regularBytes, boldBytes] = await Promise.all([
    bytes('../vendor/pretendard/Pretendard-Regular.ttf'),
    bytes('../vendor/pretendard/Pretendard-Bold.ttf'),
  ]);
  const pdf = await PDFLib.PDFDocument.create();
  pdf.registerFontkit(fontkit);
  // Pretendard's alternative TTF build is broadly compatible but fontkit cannot
  // subset its converted outlines. Embed the complete fonts to keep Korean text
  // searchable and avoid a corrupt CFF subset.
  const regular = await pdf.embedFont(regularBytes, { subset: false });
  const bold = await pdf.embedFont(boldBytes, { subset: false });
  const PAGE = [595.28, 841.89];
  const margin = 52;
  const footer = 34;
  let page = pdf.addPage(PAGE);
  let y = PAGE[1] - margin;
  const addPage = () => { page = pdf.addPage(PAGE); y = PAGE[1] - margin; };
  const drawBlock = (text, { font, size, leading, gap }) => {
    const lines = wrapText(text, font, size, PAGE[0] - margin * 2);
    for (const line of lines) {
      if (y - leading < footer + 12) addPage();
      page.drawText(line, { x: margin, y, size, font, color: PDFLib.rgb(0.09, 0.09, 0.09) });
      y -= leading;
    }
    y -= gap;
  };
  drawBlock(title, { font: bold, size: 20, leading: 28, gap: 22 });
  const blocks = translation.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  for (const block of blocks) {
    if (block.startsWith('## ')) drawBlock(block.slice(3), { font: bold, size: 13, leading: 20, gap: 8 });
    else drawBlock(block, { font: regular, size: 10.5, leading: 17, gap: 8 });
  }
  const pages = pdf.getPages();
  pages.forEach((pdfPage, index) => {
    const label = `${index + 1}`;
    pdfPage.drawText(label, {
      x: (PAGE[0] - regular.widthOfTextAtSize(label, 8)) / 2,
      y: 20,
      size: 8,
      font: regular,
      color: PDFLib.rgb(0.45, 0.45, 0.45),
    });
  });
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function createResultsZip(items) {
  await loadScript('../vendor/jszip/jszip.min.js');
  const zip = new globalThis.JSZip();
  for (const item of items) if (item.pdfBlob) zip.file(item.outputName, item.pdfBlob);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
