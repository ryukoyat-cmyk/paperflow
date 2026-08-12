const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'POST 요청만 허용됩니다.' }) };
  try {
    const jobId = crypto.randomUUID();
    const store = getStore('paperflow-jobs');
    await store.setJSON(jobId, { status: 'queued', createdAt: Date.now() });
    const origin = `${event.headers['x-forwarded-proto'] || 'https'}://${event.headers.host}`;
    const invoke = await fetch(`${origin}/.netlify/functions/translate-background`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, body: event.body, isBase64Encoded: event.isBase64Encoded, contentType: event.headers['content-type'] || '' }) });
    if (!invoke.ok && invoke.status !== 202) throw new Error('번역 작업을 시작하지 못했습니다.');
    return { statusCode: 202, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message || '번역 중 오류가 발생했습니다.' }) };
  }
};
