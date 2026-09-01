// Vercel Serverless Function: POST /api/assistant
// Design coach for the current LangCanvas graph. Auth + freemium quota (same buckets as analyze).

import { createHash } from 'node:crypto';
import admin from 'firebase-admin';
import { buildCoachPack, formatCoachUserMessage, sanitizeCoachPlan } from '../lib/coach-playbook.js';
import { generateGeminiText, LITE_TIER_MODELS } from '../lib/gemini.js';
import { isUnlimitedEmail } from '../lib/quota.js';

export const config = { maxDuration: 55 };

const PLAN_LIMITS = { free: 5, pro: 50, guest: 5 };
const GUEST_LIMIT = PLAN_LIMITS.guest;
const MAX_QUESTION = 1200;
const MAX_GRAPH_CHARS = 16000;
const MAX_EXECUTION_CHARS = 8000;
const MAX_OUTPUT_TOKENS = 2200;
const COOLDOWN_MS = 3 * 1000;

const SYSTEM_PROMPT = `You are the LangCanvas design partner. The student is building ONE graph for the job in GOAL (“problem to solve”). Help that canvas work: shared state, schemas, reads/writes, predicates — and, when they have run it, debug EXECUTION HISTORY.

You do not invent a different product. Do not convert their graph into Self-RAG / Reflexion / ReAct / a stock template unless they asked for that template. Keep their labels. Never tell them to type Python APIs on the canvas.

Speak visible UI: “problem to solve”, shared state, constants, SCHEMAS, NODE DETAIL (“output schema”, “reads”, “writes”, “stop when”, “if”, “then return”, “runs when LLM returns”), + join, panel execution / history.

LangCanvas facts (never contradict these):
- bind_tools + tool_choice = structured output to that LLM’s output schema. It does NOT attach Tavily, calculate_cost, or any catalog tool.
- Catalog tools run only as kind=tool action nodes (arrows). An LLM that “needs to search” writes search_queries; a conditional (e.g. reporte_ok?) routes to the tool node; the tool writes state; arrows return to the SAME LLM. Do not split that LLM into orquestador_inicial / orquestador_final.
- A join waits for keys from specialists that finish at different times. Do not delete it so two LLM reports can race. Do not make the join wait for later tool outputs unless the student asks.

How to think:
1. Read DESIGN LOCK, then GOAL. The lock is the architecture. Chat history refusals (“no separes”, “el join es necesario”, “no cambies tanto”) are also locks.
2. Read CURRENT CANVAS. Does state/schemas/writes implement GOAL on THAT wiring? A schema is the contract of ONE LLM shot. Shared state is what arrows carry. A join waits for keys; a conditional chooses ONE branch.
3. If EXECUTION HISTORY is present, treat it as ground truth of the last Dry run / Run. Explain why it stopped, which write never landed, which branch it took, and the canvas click that fixes it.
4. Answer QUESTION first. Then give concrete canvas actions (their real node names). If DESIGN LOCK is active, those actions are NODE DETAIL / shared state / SCHEMAS — not a new graph. Spanish → **Por qué:** **Hacé esto:** **Después:** English → **Why:** **Do this:** **Then:**
5. CHECKER HINTS are optional lint. Ignore any hint that deletes nodes, splits an LLM, linearizes a loop, or puts tools inside bind_tools.
6. Chat history is the thread. Do not restart. Do not propose a different topology than the previous assistant turn unless QUESTION asked to rewire. No markdown fences. No full programs.
If a PLAN JSON is provided, follow it ONLY if it agrees with DESIGN LOCK, GOAL, student refusals in chat, and EXECUTION HISTORY. If PLAN wants a different topology, discard PLAN and fill the existing canvas.`;

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
    if (isUnlimitedEmail(email) || isUnlimitedEmail(userData && userData.email)) {
      const count = usageSnap.exists ? Number(usageSnap.data().count || 0) : 0;
      tx.set(usageRef, {
        uid, date: day, count: count + 1, plan: 'unlimited', updatedAt: now,
      }, { merge: true });
      return { uid, plan: 'unlimited' };
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

const PLAN_SYSTEM = `You are a silent planner for LangCanvas. Read DESIGN LOCK, GOAL, CURRENT CANVAS, EXECUTION HISTORY, and QUESTION. Output JSON only. Do not tutor. Do not invent a stock template. Use the student's node labels. At most 5 issues and 5 next_clicks.

If DESIGN LOCK says the topology is locked (or QUESTION is only a greeting / “review my graph” / “y ahora?”):
- focus must be one of: state, schema, writes, reads, prompt, predicate, wait_keys, debug, greeting
- issues and next_clicks may ONLY mention shared state, schema fields, reads, writes, exprs, prompts, predicates, wait-until keys, or execution debug on EXISTING nodes
- FORBIDDEN: add/remove/rename nodes, delete join, split an LLM, put Tavily inside bind_tools, linearize a loop, delete a conditional, move tools before the orchestrator as a new architecture
LangCanvas: bind_tools = output schema, not catalog tools.`;

const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    goal_in_one_line: { type: 'STRING' },
    focus: { type: 'STRING' },
    issues: { type: 'ARRAY', items: { type: 'STRING' } },
    next_clicks: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['focus', 'issues', 'next_clicks'],
};

async function planWithLite(specText) {
  try {
    const { data } = await generateGeminiText({
      system: PLAN_SYSTEM,
      contents: [{ role: 'user', parts: [{ text: String(specText || '').slice(0, 14000) }] }],
      temperature: 0.1,
      maxOutputTokens: 500,
      asJson: true,
      responseSchema: PLAN_SCHEMA,
      models: LITE_TIER_MODELS,
    });
    if (!data || typeof data !== 'object') return null;
    return {
      goal_in_one_line: String(data.goal_in_one_line || '').slice(0, 240),
      focus: String(data.focus || '').slice(0, 80),
      issues: Array.isArray(data.issues) ? data.issues.map(String).slice(0, 5) : [],
      next_clicks: Array.isArray(data.next_clicks) ? data.next_clicks.map(String).slice(0, 5) : [],
    };
  } catch (_) {
    return null;
  }
}

async function callGemini(contents) {
  const { text } = await generateGeminiText({
    system: SYSTEM_PROMPT,
    contents,
    temperature: 0.2,
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
  if (!isUnlimitedEmail(decoded && decoded.email) && now - lastOk < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - lastOk)) / 1000);
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: `Please wait ${wait}s before another question.` });
  }

  let question = '';
  let history = [];
  let graph = null;
  let execution = null;
  let stickyPattern = '';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    question = body && body.question;
    if (Array.isArray(body && body.history)) history = body.history;
    if (body && body.graph && typeof body.graph === 'object') graph = body.graph;
    if (body && body.execution && typeof body.execution === 'object') execution = body.execution;
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
  const executionText = execution
    ? JSON.stringify(execution).slice(0, MAX_EXECUTION_CHARS)
    : '';
  const pack = buildCoachPack(graph || {}, question, stickyPattern, history);
  const specText = formatCoachUserMessage(pack, graphText, question, executionText);
  const rawPlan = await planWithLite(specText);
  const topologyLocked = !!(pack.lock && pack.lock.topologyLocked);
  const plan = sanitizeCoachPlan(rawPlan, topologyLocked);
  const contents = [];
  history.slice(-24).forEach((m) => {
    if (!m || !m.text) return;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.text).slice(0, 3500) }],
    });
  });
  const planBlock = plan
    ? '\n\nPLAN (from a smaller model — follow ONLY if it agrees with DESIGN LOCK; discard topology rewrites):\n'
      + JSON.stringify(plan)
    : '';
  contents.push({
    role: 'user',
    parts: [{ text: specText + planBlock }],
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
