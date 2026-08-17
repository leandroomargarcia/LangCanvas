// Vercel Serverless Function: POST /api/assistant
// Design coach for the current LangCanvas graph. Auth + freemium quota (same buckets as analyze).

import { createHash } from 'node:crypto';
import admin from 'firebase-admin';
import { buildCoachPack, formatCoachUserMessage } from '../lib/coach-playbook.js';
import { generateGeminiText } from '../lib/gemini.js';

export const config = { maxDuration: 30 };

const PLAN_LIMITS = { free: 5, pro: 50, guest: 5 };
const GUEST_LIMIT = PLAN_LIMITS.guest;
const MAX_QUESTION = 800;
const MAX_GRAPH_CHARS = 8000;
const MAX_OUTPUT_TOKENS = 1200;
const COOLDOWN_MS = 3 * 1000;

const SYSTEM_PROMPT = `You are a senior engineer tutoring on LangCanvas: a visual blackboard for LangGraph-style systems. The student must leave with flow + data dictionary so codegen can translate the canvas without inventing contracts.

You do not invent the product. LANGCANVAS UI FOR THIS STEP, CURRENT GAP, ROSTER, and CURRENT CANVAS in the user message are the spec. Narrate them. Do not name panels or fields that are not in that spec. Do not tell them to type Python APIs (ToolNode, ToolMessage, bind_tools, tool_choice) on the canvas — those belong in Export → Generate code.

MODE:
- pattern = they chose (or the canvas matches) a known template. Walk THAT roster and THAT gap. Keep PATTERN until they name a different one. “next” does not forget it.
- custom = architecture of their own. Fill THEIR boxes (labels on CURRENT CANVAS). Do not prescribe Reflexion / ReAct / RAG unless they ask for that pattern.

Order of construction (never dump later steps):
job → roles/arrows + one-line effects → payloads on arrows → SCHEMAS only if an LLM must return a contract → SHARED STATE as memory for the next node (not a copy of schema fields) → wire ONE node in NODE DETAIL → countable stop on the conditional → OUTPUT (end does not compute).

Rules:
- Answer QUESTION first. If they ask what to create / what to name, list ROSTER (name + one-line why) and the CANONICAL WIRE, then the CURRENT GAP clicks. Do not skip names to preach schemas.
- If they say next / nothing specific, teach CURRENT GAP only: why, then the listed clicks, then wait.
- If they do not understand, rephrase CURRENT GAP with the UI spec (which panel, which field). Do not paste the gap as a script and do not jump ahead.
- ONE step. 2–5 numbered canvas actions. Name THEIR real labels; ignore “new action”.
- Match the student language. Spanish → whole reply in Spanish with **Por qué:** **Hacé esto:** **Después:** English → **Why:** **Do this:** **Then:**
- No markdown fences. No full programs. No catalog of templates unless they ask which pattern fits the job.`;

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
  const { text } = await generateGeminiText({
    system: SYSTEM_PROMPT,
    contents,
    temperature: 0.4,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  return text;
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
  let stickyPattern = '';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    question = body && body.question;
    if (Array.isArray(body && body.history)) history = body.history;
    if (body && body.graph && typeof body.graph === 'object') graph = body.graph;
    if (body && typeof body.pattern === 'string') stickyPattern = body.pattern.trim();
    else if (body && body.lesson && typeof body.lesson.pattern === 'string') stickyPattern = body.lesson.pattern.trim();
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
  const pack = buildCoachPack(graph || {}, question, stickyPattern);
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
    parts: [{ text: formatCoachUserMessage(pack, graphText, question) }],
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
