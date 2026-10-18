import { getStore } from '@netlify/blobs';

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const EFFORT = process.env.OPENAI_REASONING_EFFORT || 'low';
const REQUESTS_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 150);

const LIMITS = { glossary: 24000, draft: 12000, review: 12000 };

// Shared translation contract. Kept on the server: the client only names a task,
// so this endpoint can never be driven as a general-purpose model proxy.
const RULES = `당신은 영어 학술 논문을 한국어로 옮기는 전문 번역가입니다. 학술적 정확성을 최우선으로 합니다.

번역 규칙
1. 문체: 논문체 평서형(~이다, ~한다)을 사용한다. '~습니다', '~해요' 같은 구어체를 쓰지 않는다.
2. 완전성: 원문의 모든 문장을 빠뜨리지 않고 번역한다. 요약, 의역, 설명 추가, 의견 삽입을 하지 않는다.
3. 용어: 학술 용어는 처음 나올 때 '한국어(English)' 형태로 적고, 이후에는 한국어만 쓴다.
4. 원문 유지: 다음은 번역하지 않고 원문 그대로 둔다.
   - 인용 표시: [12], [3, 4], (Smith et al., 2020)
   - 수식, 변수, 기호: x_i, \\alpha, O(n log n)
   - 숫자, 단위, 통계값: 3.5%, p < 0.05, 95% CI
   - 고유명사: 저자명, 기관명, 학회 및 저널명
   - 데이터셋, 모델, 도구, 라이브러리 이름: ImageNet, BERT, PyTorch
   - 코드 식별자, 파일명, URL, DOI
5. 구조 유지: Markdown 구조를 그대로 유지한다. '## '로 시작하는 줄은 제목이므로 '## '를 남기고 제목만 번역한다. 문단 구분과 줄바꿈을 원문과 동일하게 유지한다.
6. 상호 참조: Figure 3, Table 2, Section 4, Eq. (5)는 각각 '그림 3', '표 2', '4절', '식 (5)'로 옮긴다.
7. 출력: 번역문만 출력한다. 머리말, 해설, 코드 펜스를 붙이지 않는다.`;

function glossaryBlock(glossary) {
  if (!glossary?.length) return '';
  const lines = glossary.map((t) => `- ${t.en} -> ${t.ko}`).join('\n');
  return `\n\n용어집 (반드시 이 번역을 따른다)\n${lines}`;
}

function contextBlock(context) {
  if (!context?.source && !context?.target) return '';
  return `\n\n직전 문맥 (참고용이며 다시 번역하지 않는다)\n[직전 원문]\n${context.source || ''}\n[직전 번역]\n${context.target || ''}`;
}

const TASKS = {
  // One cheap pass over the abstract/intro/headings, so every chunk afterwards
  // translates the same term the same way.
  glossary: ({ text }) => ({
    instructions: `당신은 학술 번역용 용어집을 만드는 전문가입니다.
주어진 논문 발췌에서 반복적으로 쓰이는 핵심 전문 용어를 최대 40개 고르시오.
- 일반적인 영어 단어가 아니라 해당 분야의 전문 용어만 고른다.
- 각 용어에 학계에서 통용되는 한국어 번역을 제시한다.
- 학계에서 영어를 그대로 쓰는 것이 표준인 용어는 ko에도 영어를 그대로 적는다.
아래 형식의 JSON 객체 하나만 출력한다. 다른 텍스트를 붙이지 않는다.
{"terms":[{"en":"attention mechanism","ko":"주의 기제"}]}`,
    input: text,
    maxOutputTokens: 6000,
  }),

  draft: ({ text, glossary, context }) => ({
    instructions: `${RULES}${glossaryBlock(glossary)}${contextBlock(context)}

아래 원문을 번역하시오.`,
    input: text,
    maxOutputTokens: 16000,
  }),

  // The real cross-check. The previous version ran two full translations in
  // parallel and threw one away, which cost double and verified nothing.
  review: ({ text, draft, glossary }) => ({
    instructions: `당신은 학술 번역 감수자입니다. 영어 원문과 한국어 초벌 번역을 받아 교정된 번역문을 출력합니다.

점검 항목
1. 누락과 추가: 원문에 있는데 빠진 내용, 원문에 없는데 들어간 내용을 바로잡는다.
2. 숫자, 통계값, 단위, 인용 표시가 원문과 정확히 일치하는지 확인한다.
3. 용어집 준수와 용어 일관성을 확인한다.
4. 오역과 어색한 직역을 자연스러운 한국어 논문체로 다듬는다.
5. 문체가 논문체 평서형으로 일관되는지 확인한다.
6. Markdown 구조와 '## ' 제목 표시가 유지되는지 확인한다.
${RULES}${glossaryBlock(glossary)}

교정된 번역문 전체만 출력한다. 변경 사항 설명이나 머리말을 붙이지 않는다. 고칠 것이 없으면 초벌 번역을 그대로 출력한다.`,
    input: `[원문]\n${text}\n\n[초벌 번역]\n${draft}`,
    maxOutputTokens: 16000,
  }),
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

function validate(payload) {
  const { task } = payload;
  if (!Object.prototype.hasOwnProperty.call(TASKS, task)) return '알 수 없는 작업입니다.';
  const text = payload.text;
  if (typeof text !== 'string' || !text.trim()) return '번역할 원문이 비어 있습니다.';
  if (text.length > LIMITS[task]) return `한 번에 보낼 수 있는 분량을 초과했습니다. (${LIMITS[task]}자 이하)`;
  if (task === 'review' && (typeof payload.draft !== 'string' || !payload.draft.trim())) return '감수할 초벌 번역이 없습니다.';
  if (payload.draft && payload.draft.length > 24000) return '초벌 번역 분량을 초과했습니다.';
  return null;
}

// Trim client-supplied glossary/context so they cannot be used to smuggle in a
// large prompt of their own.
function sanitise(payload) {
  const glossary = Array.isArray(payload.glossary)
    ? payload.glossary
        .filter((t) => t && typeof t.en === 'string' && typeof t.ko === 'string')
        .slice(0, 60)
        .map((t) => ({ en: t.en.slice(0, 120), ko: t.ko.slice(0, 120) }))
    : [];
  const context = payload.context && typeof payload.context === 'object'
    ? { source: String(payload.context.source || '').slice(0, 600), target: String(payload.context.target || '').slice(0, 600) }
    : null;
  return {
    task: payload.task,
    text: payload.text,
    draft: typeof payload.draft === 'string' ? payload.draft : '',
    glossary,
    context,
  };
}

// Approximate per-IP guard. The endpoint is unauthenticated, so without this a
// single loop could drain the account's OpenAI credit. Never blocks on failure.
async function rateLimited(ip) {
  if (!ip || !REQUESTS_PER_MINUTE) return false;
  try {
    const store = getStore('paperflow-ratelimit');
    const key = `${ip}:${Math.floor(Date.now() / 60000)}`;
    const used = Number((await store.get(key)) || 0);
    if (used >= REQUESTS_PER_MINUTE) return true;
    await store.set(key, String(used + 1));
    return false;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callOpenAI(spec, { dropReasoning = false } = {}) {
  const body = {
    model: MODEL,
    instructions: spec.instructions,
    input: spec.input,
    max_output_tokens: spec.maxOutputTokens,
    stream: true,
  };
  if (!dropReasoning) body.reasoning = { effort: EFFORT };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(detail.slice(0, 600));
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  return response;
}

// Retries happen before a single byte of translation is emitted, so a retry can
// never duplicate text the client already received.
async function openStreamWithRetry(spec) {
  let dropReasoning = false;
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await callOpenAI(spec, { dropReasoning });
    } catch (error) {
      lastError = error;
      const status = error.status;
      // The model or account may not accept `reasoning`; retry once without it
      // rather than failing the whole document.
      if (status === 400 && !dropReasoning && /reasoning|unsupported|unknown parameter/i.test(error.detail || '')) {
        dropReasoning = true;
        continue;
      }
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt === 3) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function readableApiError(error) {
  try {
    const parsed = JSON.parse(error.detail);
    const message = parsed?.error?.message;
    if (message) {
      if (/does not exist|not found|invalid model/i.test(message)) {
        return `모델 '${MODEL}' 을 사용할 수 없습니다. OPENAI_MODEL 환경 변수를 확인하세요. (${message})`;
      }
      if (/api key|unauthorized|incorrect/i.test(message)) {
        return 'OPENAI_API_KEY 가 올바르지 않습니다. Netlify 환경 변수를 확인하세요.';
      }
      return message;
    }
  } catch {
    /* not JSON */
  }
  if (error.status === 401) return 'OPENAI_API_KEY 가 설정되지 않았거나 올바르지 않습니다.';
  if (error.status === 429) return 'OpenAI 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.';
  return error.message || 'OpenAI 호출에 실패했습니다.';
}

export default async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'POST 요청만 허용됩니다.' });
  if (!process.env.OPENAI_API_KEY) return json(500, { error: 'OPENAI_API_KEY 환경 변수가 설정되지 않았습니다.' });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: '요청 본문을 읽을 수 없습니다.' });
  }

  const invalid = validate(payload || {});
  if (invalid) return json(400, { error: invalid });

  const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (await rateLimited(ip)) return json(429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });

  const clean = sanitise(payload);
  const spec = TASKS[clean.task](clean);

  let upstream;
  try {
    upstream = await openStreamWithRetry(spec);
  } catch (error) {
    return json(502, { error: readableApiError(error) });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      // Emitted immediately so the response has a first byte well inside the
      // platform's time-to-first-byte budget.
      send({ type: 'start', model: MODEL });

      const reader = upstream.body.getReader();
      let buffer = '';
      let produced = 0;

      let terminalEventSeen = false;
      const handleEvent = (raw) => {
        const lines = raw.replace(/\\r/g, '').split('\\n');
        const dataLines = lines.filter((line) => line.startsWith('data:'));
        if (!dataLines.length) return;
        const data = dataLines.map((line) => line.slice(5).trim()).join('\\n');
        if (!data || data === '[DONE]') return;

        let event;
        try {
          event = JSON.parse(data);
        } catch {
          send({ type: 'error', message: 'OpenAI 스트림 이벤트를 해석하지 못했습니다.' });
          terminalEventSeen = true;
          return;
        }

        switch (event.type) {
          case 'response.output_text.delta':
            if (typeof event.delta === 'string' && event.delta.length) {
              produced += event.delta.length;
              send({ type: 'delta', text: event.delta });
            }
            break;
          case 'response.output_text.done':
            if (!produced && typeof event.text === 'string' && event.text.length) {
              produced += event.text.length;
              send({ type: 'delta', text: event.text });
            }
            break;
          case 'response.completed': {
            terminalEventSeen = true;
            const response = event.response || {};
            if (!produced) {
              const content = (response.output || []).flatMap((item) => item.content || []);
              const refusal = content.find((item) => item.type === 'refusal' && item.refusal);
              const fallback = content
                .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
                .map((item) => item.text).join('');
              if (fallback) {
                produced += fallback.length;
                send({ type: 'delta', text: fallback });
              } else if (refusal) {
                send({ type: 'error', message: `모델이 요청을 거부했습니다: ${refusal.refusal}` });
              }
            }
            send({ type: 'done', usage: response.usage ?? null });
            break;
          }
          case 'response.incomplete':
            terminalEventSeen = true;
            send({
              type: 'error',
              code: event.response?.incomplete_details?.reason === 'max_output_tokens' ? 'truncated' : 'incomplete',
              message: event.response?.incomplete_details?.reason === 'max_output_tokens'
                ? '출력 토큰 한도로 응답이 중단되었습니다.'
                : `모델 응답이 완료되지 않았습니다. (사유: ${event.response?.incomplete_details?.reason || '알 수 없음'})`,
            });
            break;
          case 'response.failed':
            terminalEventSeen = true;
            send({ type: 'error', message: event.response?.error?.message || '모델 응답이 실패했습니다.' });
            break;
          case 'error':
            terminalEventSeen = true;
            send({ type: 'error', message: event.message || event.error?.message || 'OpenAI 스트림 오류가 발생했습니다.' });
            break;
          default:
            break;
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            handleEvent(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + (buffer.startsWith('\\r\\n\\r\\n', boundary) ? 4 : 2));
            boundary = buffer.indexOf('\n\n');
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) handleEvent(buffer);
        if (!produced && !terminalEventSeen) {
          send({ type: 'error', message: 'OpenAI 스트림이 완료 이벤트 없이 종료되어 번역 텍스트를 받지 못했습니다.' });
        } else if (!produced && terminalEventSeen) {
          // Terminal event handlers already sent the specific failure or refusal reason.
        }
      } catch (error) {
        send({ type: 'error', message: error.message || '스트리밍이 중단되었습니다.' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
};
