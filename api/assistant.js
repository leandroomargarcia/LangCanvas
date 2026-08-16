// Vercel Serverless Function: POST /api/assistant
// Design coach for the current LangCanvas graph. Auth + freemium quota (same buckets as analyze).

import { createHash } from 'node:crypto';
import admin from 'firebase-admin';

export const config = { maxDuration: 30 };

const MODEL = 'gemini-flash-lite-latest';
const PLAN_LIMITS = { free: 5, pro: 50, guest: 5 };
const GUEST_LIMIT = PLAN_LIMITS.guest;
const MAX_QUESTION = 800;
const MAX_GRAPH_CHARS = 8000;
const MAX_OUTPUT_TOKENS = 700;
const COOLDOWN_MS = 20 * 1000;

const SYSTEM_PROMPT = `You are the LangCanvas design coach. The student is building ANY LangGraph-style system on a visual canvas — not only Reflexion.

Help them COMPLETE THEIR SYSTEM in this order: (1) the job, (2) roles and arrows, (3) data that crosses each arrow, (4) schemas only if an LLM must return a contract, (5) shared state as memory not a copy of schemas, (6) wire each node (LLM / tool / function / conditional), (7) how the loop stops, (8) graph OUTPUT.

LangCanvas Templates (teach these as patterns; load from Templates ▾ or rebuild by hand):
- Simple branch: one decision, two paths.
- Retry / repair: try → evaluate → retry or end (budget: attempts).
- ReAct: agent → tools_condition → tools, loop until the model answers without a tool call.
- Reflection: generate → critique → refine until OK or max iterations (no web search).
- Reflexion: draft → search tools → revise → event_loop; stop after N tool rounds; structured AnswerQuestion / ReviseAnswer.
- Tool-calling: LLM chooses tools until it can finish.
- Plan-and-execute: plan steps[], then run them one by one.
- RAG: retrieve → enough context? → generate or fallback.
- Supervisor + workers: router sends work to specialist agents, then continue or end.
- Map-reduce: split → workers → merge.
- Human-in-the-loop: draft action → human approve/reject → continue or revise.
- Guardrails: validate input → agent → check output.

Rules:
- Detect which pattern (or mix) they are actually drawing from CURRENT CANVAS. Do not assume Reflexion.
- If they ask “which template?” or the canvas is empty, map their job to a template and give the NEXT construction step only.
- Talk about the canvas, not LangGraph APIs. Do not tell them to type ToolNode, ToolMessage, bind_tools, or tool_choice on the canvas. Those exist only in generated code.
- Be specific to the CURRENT CANVAS JSON. Name their nodes, schemas, and missing links.
- Short: 4–8 sentences or a short numbered list. One next action at the end.
- English. No markdown fences. Bold sparingly with **title:** if useful.
- If they ask to generate Python, point them to Export → Generate code; you design, you do not dump full programs.`;

const lastOkByUid = new Map();

function normalizePrivateKey(raw) {
  let privateKey = String(raw || '').trim();
  if (
    (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
    (privateKey.startsWith("'") && privateKey.endsWith("'"))
  ) {
    privateKey = privateKey.slice(1, -1);
  }
  return privateKey.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
}

function initFirebase() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) {
    const err = new Error('Server missing Firebase Admin credentials.');
    err.status = 500;
    throw err;
  }
  privateKey = normalizePrivateKey(privateKey);
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    const err = new Error('FIREBASE_PRIVATE_KEY looks invalid (missing PEM header).');
    err.status = 500;
    throw err;
  }
  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

function getDb() {
  initFirebase();
  return admin.firestore();
}

async function verifyBearer(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const err = new Error('Sign in required.');
    err.status = 401;
    throw err;
  }
  initFirebase();
  try {
    return await admin.auth().verifyIdToken(match[1]);
  } catch (_) {
    const err = new Error('Invalid or expired session. Please sign in again.');
    err.status = 401;
    throw err;
  }
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  const real = req.headers['x-real-ip'] || req.headers['X-Real-Ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function hashKey(value) {
  const salt = process.env.IP_HASH_SALT || 'langcanvas';
  return createHash('sha256').update(String(value || 'unknown') + '|' + salt).digest('hex').slice(0, 32);
}

function ipHash(ip) {
  return hashKey('ip:' + String(ip || 'unknown'));
}

function normalizeGuestId(raw) {
  const s = String(raw || '').trim();
  if (/^[a-f0-9-]{16,64}$/i.test(s)) return s.toLowerCase();
  return null;
}

function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function reserveGuestQuota(req) {
  const db = getDb();
  const ip = clientIp(req);
  const guestId = normalizeGuestId(
    req.headers['x-langcanvas-guest-id'] || req.headers['X-LangCanvas-Guest-Id'],
  );
  const ipKey = ipHash(ip);
  const guestKey = guestId ? hashKey('guest:' + guestId) : null;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ipRef = db.collection('guest_usage').doc('ip_' + ipKey);
  const guestRef = guestKey ? db.collection('guest_usage').doc('g_' + guestKey) : null;

  return await db.runTransaction(async (tx) => {
    const ipSnap = await tx.get(ipRef);
    const guestSnap = guestRef ? await tx.get(guestRef) : null;
    const ipCount = ipSnap.exists ? Number(ipSnap.data().count || 0) : 0;
    const guestCount = guestSnap && guestSnap.exists ? Number(guestSnap.data().count || 0) : 0;
    const used = Math.max(ipCount, guestCount);
    if (used >= GUEST_LIMIT) {
      const err = new Error(
        `Free trial limit reached (${GUEST_LIMIT} AI requests). Sign in / subscribe for more.`,
      );
      err.status = 429;
      err.code = 'quota_exceeded';
      throw err;
    }
    const next = used + 1;
    const payload = { count: next, limit: GUEST_LIMIT, plan: 'guest', updatedAt: now };
    tx.set(ipRef, {
      ...payload,
      kind: 'ip',
      createdAt: ipSnap.exists ? (ipSnap.data().createdAt || now) : now,
    }, { merge: true });
    if (guestRef) {
      tx.set(guestRef, {
        ...payload,
        kind: 'guest',
        createdAt: guestSnap && guestSnap.exists ? (guestSnap.data().createdAt || now) : now,
      }, { merge: true });
    }
    return { uid: guestKey ? `guest:${guestKey}` : `guest-ip:${ipKey}`, plan: 'guest' };
  });
}

async function ensureUserAndReserveQuota(decoded) {
  const db = getDb();
  const uid = decoded.uid;
  const email = decoded.email || '';
  const day = utcDay();
  const userRef = db.collection('users').doc(uid);
  const usageRef = db.collection('usage').doc(`${uid}_${day}`);

  return await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    const usageSnap = await tx.get(usageRef);
    let plan = 'free';
    const now = admin.firestore.FieldValue.serverTimestamp();
    const userData = userSnap.exists ? (userSnap.data() || {}) : null;
    if (!userData) {
      tx.set(userRef, {
        email,
        displayName: decoded.name || '',
        photoURL: decoded.picture || '',
        plan: 'free',
        createdAt: now,
        updatedAt: now,
      });
    } else {
      plan = userData.plan === 'pro' ? 'pro' : 'free';
      tx.set(userRef, {
        email: userData.email || email,
        displayName: decoded.name || userData.displayName || '',
        photoURL: decoded.picture || userData.photoURL || '',
        updatedAt: now,
      }, { merge: true });
    }
    const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const count = usageSnap.exists ? Number(usageSnap.data().count || 0) : 0;
    if (count >= limit) {
      const err = new Error(
        plan === 'pro'
          ? `Daily Pro limit reached (${limit} AI requests). Try again tomorrow.`
          : `Free plan limit reached (${limit} AI requests / day). Upgrade to Pro for a higher daily quota.`,
      );
      err.status = 429;
      err.code = 'quota_exceeded';
      throw err;
    }
    tx.set(usageRef, {
      uid, date: day, count: count + 1, plan, updatedAt: now,
    }, { merge: true });
    return { uid, plan };
  });
}

async function callGemini(contents) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('Server missing GEMINI_API_KEY.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const geminiRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: { temperature: 0.4, maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
  });
  if (!geminiRes.ok) {
    const err = new Error('AI provider error.');
    err.status = 502;
    err.detail = (await geminiRes.text()).slice(0, 300);
    throw err;
  }
  const data = await geminiRes.json();
  const text = data.candidates
    && data.candidates[0]
    && data.candidates[0].content
    && data.candidates[0].content.parts
    && data.candidates[0].content.parts.map(p => p.text || '').join('');
  if (!text) {
    const err = new Error('AI returned an empty response.');
    err.status = 502;
    throw err;
  }
  return text.trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-LangCanvas-Guest-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  if (!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    return res.status(500).json({ error: 'Server missing GEMINI_API_KEY.' });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const hasBearer = /^Bearer\s+\S+/i.test(String(authHeader));
  let decoded = null;
  if (hasBearer) {
    try {
      decoded = await verifyBearer(req);
    } catch (err) {
      return res.status(err.status || 401).json({ error: err.message || 'Sign in required.' });
    }
  }

  const uidKey = decoded ? decoded.uid : `ip:${ipHash(clientIp(req))}`;
  const lastOk = lastOkByUid.get(uidKey) || 0;
  const now = Date.now();
  if (now - lastOk < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - lastOk)) / 1000);
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: `Please wait ${wait}s before another question.` });
  }

  let question = '';
  let history = [];
  let graph = null;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    question = body && body.question;
    if (Array.isArray(body && body.history)) history = body.history;
    if (body && body.graph && typeof body.graph === 'object') graph = body.graph;
  } catch (_) {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Missing "question".' });
  }
  question = question.trim().slice(0, MAX_QUESTION);
  if (!question) return res.status(400).json({ error: 'Empty question.' });

  try {
    if (decoded) await ensureUserAndReserveQuota(decoded);
    else await reserveGuestQuota(req);
  } catch (err) {
    if (err && err.status === 429) {
      res.setHeader('Retry-After', '3600');
      return res.status(429).json({ error: err.message, code: err.code || 'quota_exceeded' });
    }
    console.error('assistant_quota_failed', err && err.message);
    return res.status(500).json({ error: 'Could not check usage quota.' });
  }

  const graphText = JSON.stringify(graph || {}).slice(0, MAX_GRAPH_CHARS);
  const contents = [];
  history.slice(-8).forEach((m) => {
    if (!m || !m.text) return;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.text).slice(0, 1500) }],
    });
  });
  contents.push({
    role: 'user',
    parts: [{ text: 'CURRENT CANVAS:\n' + graphText + '\n\nQUESTION:\n' + question }],
  });

  try {
    const reply = await callGemini(contents);
    lastOkByUid.set(uidKey, Date.now());
    return res.status(200).json({ reply, source: 'live' });
  } catch (err) {
    console.error('assistant_gemini_failed', err && err.message, err && err.detail);
    return res.status(err.status || 502).json({ error: err.message || 'AI provider error.' });
  }
}
