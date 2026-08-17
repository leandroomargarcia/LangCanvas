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
  return /not found|NOT_FOUND|UNAVAILABLE|high demand|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(body || '');
}

export async function generateGeminiText({
  system,
  contents,
  temperature = 0.3,
  maxOutputTokens = 1024,
}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('Server missing GEMINI_API_KEY.');

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
          generationConfig: { temperature, maxOutputTokens },
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
    if (text) return { text, model };
    lastDetail = model + ' empty response';
  }

  const err = new Error('AI provider error.');
  err.status = 502;
  err.detail = lastDetail || 'All free-tier Gemini models failed.';
  throw err;
}
