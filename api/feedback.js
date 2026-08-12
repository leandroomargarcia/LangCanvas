// Vercel Serverless Function: POST /api/feedback
// Sends feedback email via Resend (no mailto / no client mail app).

import { createHash } from 'node:crypto';

const FEEDBACK_TO = process.env.FEEDBACK_TO || 'leandroomargarcia@gmail.com';
const RESEND_FROM = process.env.RESEND_FROM || 'LangCanvas <onboarding@resend.dev>';
const MAX_SUBJECT = 120;
const MAX_BODY = 4000;
const COOLDOWN_MS = 60 * 1000;
const MAX_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

const hitsByKey = new Map();
const lastOkByKey = new Map();

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  const real = req.headers['x-real-ip'] || req.headers['X-Real-Ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateKey(req) {
  const ip = clientIp(req);
  const salt = process.env.IP_HASH_SALT || 'langcanvas';
  return createHash('sha256').update(String(ip) + '|' + salt).digest('hex').slice(0, 24);
}

function checkRate(key) {
  const now = Date.now();
  const lastOk = lastOkByKey.get(key) || 0;
  if (now - lastOk < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - lastOk)) / 1000);
    return { limited: true, status: 429, error: `Please wait ${wait}s before sending more feedback.`, retryAfter: wait };
  }
  let hits = (hitsByKey.get(key) || []).filter((t) => now - t < HOUR_MS);
  if (hits.length >= MAX_PER_HOUR) {
    return { limited: true, status: 429, error: 'Feedback limit reached. Try again later.', retryAfter: 3600 };
  }
  hits.push(now);
  hitsByKey.set(key, hits);
  return { limited: false };
}

async function sendWithResend({ subject, message, meta }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    const err = new Error('Server missing RESEND_API_KEY.');
    err.status = 500;
    throw err;
  }

  const text = [
    message,
    '',
    '—',
    `Plan/context: ${meta.plan || 'unknown'}`,
    meta.guestId ? `Guest id: ${meta.guestId}` : null,
    meta.uid ? `Uid: ${meta.uid}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [FEEDBACK_TO],
      subject: subject.slice(0, MAX_SUBJECT),
      text,
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    const err = new Error('Could not send feedback email.');
    err.status = 502;
    err.detail = detail;
    throw err;
  }
  return res.json().catch(() => ({}));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-LangCanvas-Guest-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const key = rateKey(req);
  const soft = checkRate(key);
  if (soft.limited) {
    res.setHeader('Retry-After', String(soft.retryAfter || 60));
    return res.status(soft.status).json({ error: soft.error });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (_) {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  const subject = String(body?.subject || 'LangCanvas feedback').trim();
  const message = String(body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message is required.' });
  if (message.length > MAX_BODY) {
    return res.status(400).json({ error: `Message too long (max ${MAX_BODY} characters).` });
  }

  const meta = {
    plan: typeof body?.plan === 'string' ? body.plan.slice(0, 40) : '',
    guestId: typeof body?.guestId === 'string' ? body.guestId.slice(0, 64) : '',
    uid: typeof body?.uid === 'string' ? body.uid.slice(0, 64) : '',
  };

  try {
    await sendWithResend({ subject, message, meta });
    lastOkByKey.set(key, Date.now());
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err && err.status === 502) {
      return res.status(502).json({ error: err.message, detail: err.detail });
    }
    return res.status(err?.status || 500).json({
      error: err?.message || 'Unexpected error sending feedback.',
    });
  }
}
