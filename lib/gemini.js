// Free-tier Gemini cascade. Each model id has its own RPM/RPD in a Free project
// (see https://ai.google.dev/gemini-api/docs/rate-limits). Trying the next id
// after 429/404/503 stretches the daily free quota instead of failing or
// jumping to a paid Flash/Pro.

export const FREE_TIER_MODELS = [
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
];

function extractText(data) {
  const parts = data
    && data.candidates
    && data.candidates[0]
    && data.candidates[0].content
    && data.candidates[0].content.parts;
  if (!parts) return '';
  return parts.map(p => p.text || '').join('').trim();
}

function shouldTryNext(status, body) {
  if (status === 404 || status === 429 || status === 503) return true;
  return /not found|NOT_FOUND|UNAVAILABLE|high demand|RESOURCE_EXHAUSTED|quota|rate.?limit|INVALID_ARGUMENT|responseSchema|response_schema|mime/i.test(body || '');
}

export function repairTruncatedJson(s) {
  let inStr = false;
  let escape = false;
  const stack = [];
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out += ch;
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if ((ch === '}' || ch === ']') && stack.length) stack.pop();
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  while (stack.length) out += stack.pop();
  return out;
}

export function extractJsonValue(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const attempts = [s];
  const objStart = s.indexOf('{');
  const arrStart = s.indexOf('[');
  let start = -1;
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) start = objStart;
  else if (arrStart >= 0) start = arrStart;
  if (start > 0) attempts.push(s.slice(start));
  else if (start === 0 && s !== attempts[0]) attempts.push(s);
  if (start >= 0) {
    const slice = s.slice(start);
    const last = Math.max(slice.lastIndexOf('}'), slice.lastIndexOf(']'));
    if (last > 0) attempts.push(slice.slice(0, last + 1));
    attempts.push(repairTruncatedJson(slice));
  }
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }
  return null;
}

export function fieldsToGeminiSchema(fields) {
  const properties = {};
  const required = [];
  (fields || []).forEach(f => {
    if (!f || !f.key) return;
    properties[f.key] = fieldToGeminiType(f);
    required.push(f.key);
  });
  return { type: 'OBJECT', properties, required };
}

function fieldToGeminiType(f) {
  const t = String(f.type || 'str');
  if (t === 'int') return { type: 'INTEGER' };
  if (t === 'bool') return { type: 'BOOLEAN' };
  if (t === 'list' || t === 'list[str]') return { type: 'ARRAY', items: { type: 'STRING' } };
  if (t.indexOf('schema:') === 0) {
    if (f.nestedFields && f.nestedFields.length) return fieldsToGeminiSchema(f.nestedFields);
    return { type: 'OBJECT', properties: {} };
  }
  return { type: 'STRING' };
}

export async function generateGeminiText({
  system,
  contents,
  temperature = 0.3,
  maxOutputTokens = 1024,
  responseMimeType = '',
  responseSchema = null,
  asJson = false,
}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('Server missing GEMINI_API_KEY.');

  const generationConfig = { temperature, maxOutputTokens };
  if (responseMimeType) generationConfig.responseMimeType = responseMimeType;
  if (responseSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = responseSchema;
  }

  let lastDetail = '';
  for (const model of FREE_TIER_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig,
        }),
      });
    } catch (err) {
      lastDetail = (err && err.message) || 'network error';
      continue;
    }
    if (!res.ok) {
      const errText = await res.text();
      lastDetail = model + ' ' + res.status + ' ' + errText.slice(0, 220);
      if (shouldTryNext(res.status, errText)) continue;
      const err = new Error('AI provider error.');
      err.status = 502;
      err.detail = lastDetail;
      throw err;
    }
    const data = await res.json();
    const text = extractText(data);
    if (asJson) {
      const parsed = extractJsonValue(text);
      if (parsed != null && typeof parsed === 'object') return { text, model, data: parsed };
      const reason = data && data.candidates && data.candidates[0] && data.candidates[0].finishReason;
      lastDetail = model + ' non-JSON' + (reason ? ' (' + reason + ')' : '') + ': ' + String(text || '').slice(0, 160);
      continue;
    }
    if (text) return { text, model };
    lastDetail = model + ' empty response';
  }

  const err = new Error(asJson ? 'Model did not return JSON.' : 'AI provider error.');
  err.status = 502;
  err.detail = lastDetail || 'All free-tier Gemini models failed.';
  throw err;
}

export async function generateGeminiJson({
  system,
  userText,
  temperature = 0.2,
  maxOutputTokens = 4096,
  responseSchema = null,
}) {
  const systemJson = system + '\n\nReturn ONLY a valid JSON object. No markdown, no commentary.';
  const contents = [{ role: 'user', parts: [{ text: userText }] }];
  const call = (schema) => generateGeminiText({
    system: systemJson,
    contents,
    temperature,
    maxOutputTokens,
    responseMimeType: 'application/json',
    responseSchema: schema,
    asJson: true,
  });
  try {
    const result = await call(responseSchema || null);
    return { data: result.data, model: result.model, raw: result.text };
  } catch (err) {
    if (responseSchema) {
      const result = await call(null);
      return { data: result.data, model: result.model, raw: result.text };
    }
    throw err;
  }
}
