const { getStore } = require('@netlify/blobs');
exports.handler = async (event) => {
  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: 'jobId가 필요합니다.' }) };
  const job = await getStore('paperflow-jobs').get(jobId, { type: 'json' });
  if (!job) return { statusCode: 404, body: JSON.stringify({ error: '작업을 찾을 수 없습니다.' }) };
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job) };
};
