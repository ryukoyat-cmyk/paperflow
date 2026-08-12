const { getStore } = require('@netlify/blobs');
const pdfParse = require('pdf-parse');
const MODEL = 'gpt-5.6-luna';
async function ask(instructions, input) {
  const r = await fetch('https://api.openai.com/v1/responses', { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.OPENAI_API_KEY}`}, body:JSON.stringify({model:MODEL,max_output_tokens:7000,input:[{role:'system',content:instructions},{role:'user',content:input}]}) });
  const d = await r.json(); if (!r.ok) throw new Error(d.error?.message || 'OpenAI API 요청에 실패했습니다.');
  return d.output_text || d.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('') || '';
}
exports.handler = async (event) => {
  const store = getStore('paperflow-jobs'); let jobId;
  try {
    const payload = JSON.parse(event.body || '{}'); jobId = payload.jobId;
    await store.setJSON(jobId, { status:'processing', progress:15 });
    const raw = Buffer.from(payload.body || '', payload.isBase64Encoded ? 'base64' : 'utf8');
    const boundary = payload.contentType.split('boundary=')[1]; if (!boundary) throw new Error('PDF 업로드 형식을 읽을 수 없습니다.');
    const start = raw.indexOf(Buffer.from('\r\n\r\n')) + 4; const end = raw.indexOf(Buffer.from(`--${boundary}`), start) - 2;
    const text = (await pdfParse(raw.subarray(start, end))).text.trim();
    if (!text) throw new Error('텍스트를 추출할 수 없는 PDF입니다. 스캔 PDF는 아직 지원하지 않습니다.');
    if (text.length > 50000) throw new Error('현재 서버 제한으로 50,000자 이하 PDF만 처리할 수 있습니다.');
    await store.setJSON(jobId, { status:'processing', progress:30 });
    const base = '영어 학술 논문을 정확하고 자연스러운 한국어로 번역하세요. 누락·숫자·인용·용어를 스스로 점검하세요. 제목, 문단, 표, 숫자, 단위, 인용 번호, 수식 표기는 보존하고 번역문만 출력하세요.';
    const [a,b] = await Promise.all([ask(`${base} 원문 충실도 우선.`, text), ask(`${base} 한국어 학술 문체 우선.`, text)]);
    await store.setJSON(jobId, { status:'completed', progress:100, translation:b||a, summary:'GPT-5.6 Luna 두 결과를 동시에 생성했습니다.' });
  } catch (error) { if (jobId) await store.setJSON(jobId, { status:'failed', progress:100, error:error.message }); }
  return { statusCode: 202, body: '' };
};
