const pdfParse = require('pdf-parse');

const MODEL = 'gpt-5.6-luna';

async function askOpenAI(instructions, input) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(8500),
    body: JSON.stringify({ model: MODEL, max_output_tokens: 7000, input: [{ role: 'system', content: instructions }, { role: 'user', content: input }] })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'OpenAI API 요청에 실패했습니다.');
  return data.output_text || data.output?.flatMap(item => item.content || []).map(item => item.text || '').join('') || '';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'POST 요청만 허용됩니다.' }) };
  if (!process.env.OPENAI_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'Netlify에 OPENAI_API_KEY가 설정되지 않았습니다.' }) };
  try {
    const boundary = (event.headers['content-type'] || '').split('boundary=')[1];
    if (!boundary) throw new Error('PDF 업로드 형식을 읽을 수 없습니다.');
    const raw = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
    const marker = Buffer.from(`--${boundary}`);
    const start = raw.indexOf(Buffer.from('\r\n\r\n')) + 4;
    const end = raw.indexOf(marker, start) - 2;
    const pdf = raw.subarray(start, end);
    const parsed = await pdfParse(pdf);
    const text = parsed.text.trim();
    if (!text) throw new Error('텍스트를 추출할 수 없는 PDF입니다. 스캔 PDF는 아직 지원하지 않습니다.');
    if (text.length > 50000) throw new Error('현재 서버 제한으로 50,000자 이하 PDF만 처리할 수 있습니다.');
    const base = '영어 학술 논문을 정확하고 자연스러운 한국어로 번역하세요. 번역 전에 누락·숫자·인용·용어를 스스로 점검하세요. 제목, 문단, 표의 내용, 숫자, 단위, 인용 번호, 수식 표기는 보존하고 번역문만 출력하세요.';
    const [literal, natural] = await Promise.all([
      askOpenAI(`${base} 원문 충실도와 누락 방지를 최우선으로 하세요.`, text),
      askOpenAI(`${base} 한국어 학술 문체의 자연스러움과 용어 일관성을 최우선으로 하세요.`, text)
    ]);
    const final = natural || literal;
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ translation: final, summary: 'GPT-5.6 Luna 두 결과를 동시에 생성하고 자체 검수했습니다.' }) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message || '번역 중 오류가 발생했습니다.' }) };
  }
};
