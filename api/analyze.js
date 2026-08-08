// Vercel Serverless Function: POST /api/analyze
// Recibe { prompt } desde el frontend, llama a Gemini con la API key escondida,
// y devuelve { text }. Incluye rate limiting por IP en memoria.

const WINDOW_MS = 60 * 1000; // 1 minuto
const MAX_REQUESTS = 5;      // 5 análisis por IP por minuto
const hits = new Map();
const MODEL = 'gemini-flash-lite-latest';

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (arr.length >= MAX_REQUESTS) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr); return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido. Usá POST.' });

  const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) return res.status(429).json({ error: 'Demasiados análisis seguidos. Esperá un minuto e intentá de nuevo.' });

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'El servidor no tiene configurada la GEMINI_API_KEY.' });

  let prompt;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    prompt = body && body.prompt;
  } catch (e) {
    return res.status(400).json({ error: 'Body inválido: se esperaba JSON con { prompt }.' });
  }
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Falta el campo "prompt".' });
  if (prompt.length > 8000) return res.status(400).json({ error: 'El prompt es demasiado largo.' });

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: 'You are an expert in designing agents with LangGraph. Give concrete, direct, practical design critiques in English.' }],
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1000,
        },
      }),
    });
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(502).json({ error: 'Error del proveedor de IA.', detail: errText.slice(0, 300) });
    }
    const data = await geminiRes.json();
    const text = data.candidates
      && data.candidates[0]
      && data.candidates[0].content
      && data.candidates[0].content.parts
      && data.candidates[0].content.parts.map(p => p.text || '').join('');
    if (!text) return res.status(502).json({ error: 'La IA no devolvió una respuesta utilizable.' });
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: 'Error inesperado al contactar la IA.', detail: String(err).slice(0, 300) });
  }
}
