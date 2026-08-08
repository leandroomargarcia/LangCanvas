// Vercel Serverless Function: POST /api/analyze
// Gemini design critique with aggressive in-memory rate limits (public demo).
// Note: limits are best-effort on serverless (instances recycle). For hard caps use Redis/Upstash.

const MODEL = 'gemini-flash-lite-latest';

// Aggressive public-demo limits
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_MINUTE = 1;          // 1 analysis / IP / minute
const MAX_PER_DAY = 5;             // 5 analyses / IP / day
const MAX_GLOBAL_PER_DAY = 80;     // soft cap across this instance
const MAX_PROMPT_CHARS = 4000;
const MAX_OUTPUT_TOKENS = 500;
const COOLDOWN_MS = 90 * 1000;     // extra gap after a successful call

const hitsByIp = new Map(); // ip -> number[]
const lastOkByIp = new Map(); // ip -> timestamp
let globalHits = [];

function prune(arr, windowMs, now) {
  return arr.filter(t => now - t < windowMs);
}

function checkRateLimit(ip) {
  const now = Date.now();
  globalHits = prune(globalHits, DAY_MS, now);
  if (globalHits.length >= MAX_GLOBAL_PER_DAY) {
    return { limited: true, status: 429, error: 'Daily demo capacity reached. Try again tomorrow.', retryAfter: 3600 };
  }

  const lastOk = lastOkByIp.get(ip) || 0;
  if (now - lastOk < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - lastOk)) / 1000);
    return { limited: true, status: 429, error: `Please wait ${wait}s before another analysis.`, retryAfter: wait };
  }

  let hits = prune(hitsByIp.get(ip) || [], DAY_MS, now);
  const minuteHits = prune(hits, MINUTE_MS, now);
  if (minuteHits.length >= MAX_PER_MINUTE) {
    return { limited: true, status: 429, error: 'Limit: 1 analysis per minute per visitor. Please wait.', retryAfter: 60 };
  }
  if (hits.length >= MAX_PER_DAY) {
    return { limited: true, status: 429, error: 'Daily limit reached (5 analyses per visitor). Try again tomorrow.', retryAfter: 3600 };
  }

  hits.push(now);
  hitsByIp.set(ip, hits);
  globalHits.push(now);
  return { limited: false };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').toString().split(',')[0].trim();
  const limit = checkRateLimit(ip);
  if (limit.limited) {
    res.setHeader('Retry-After', String(limit.retryAfter || 60));
    return res.status(limit.status).json({ error: limit.error });
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server missing GEMINI_API_KEY.' });

  let prompt;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    prompt = body && body.prompt;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid body: expected JSON with { prompt }.' });
  }
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing "prompt" field.' });
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: `Prompt too long (max ${MAX_PROMPT_CHARS} characters).` });
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: 'You are an expert in designing agents with LangGraph. Give a short, concrete, practical design critique in English (max ~8 bullet points).' }],
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      }),
    });
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      // Don't consume daily quota slot semantics beyond recording attempt; still mark cooldown lightly
      return res.status(502).json({ error: 'AI provider error.', detail: errText.slice(0, 300) });
    }
    const data = await geminiRes.json();
    const text = data.candidates
      && data.candidates[0]
      && data.candidates[0].content
      && data.candidates[0].content.parts
      && data.candidates[0].content.parts.map(p => p.text || '').join('');
    if (!text) return res.status(502).json({ error: 'AI returned an empty response.' });

    lastOkByIp.set(ip, Date.now());
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: 'Unexpected error calling the AI.', detail: String(err).slice(0, 300) });
  }
}
