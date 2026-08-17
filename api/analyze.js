// Vercel Serverless Function: POST /api/analyze
// Requires Firebase Auth. Freemium quotas in Firestore. Optional LangSmith tracing.

import { createHash } from 'node:crypto';
import admin from 'firebase-admin';
import { Client } from 'langsmith';
import { traceable } from 'langsmith/traceable';
import { generateGeminiText } from '../lib/gemini.js';

const SYSTEM_PROMPT =
  'You are an expert in designing agents with LangGraph. Critique the graph design in English. ' +
  'Format strictly: optional one-sentence intro, then 4-8 bullets only. ' +
  'Each bullet MUST be: * **Short title:** concrete actionable feedback. ' +
  'If you propose a better graph, end with one bullet titled **Suggested flow:** using arrows (A → B → C). ' +
  'No headings, no numbered lists, no preamble longer than one sentence.';

const PLAN_LIMITS = { free: 5, pro: 50, guest: 5 };
const GUEST_LIMIT = PLAN_LIMITS.guest;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_MINUTE = 1;
const MAX_GLOBAL_PER_DAY = 80;
const MAX_PROMPT_CHARS = 4000;
const MAX_OUTPUT_TOKENS = 500;
const COOLDOWN_MS = 90 * 1000;

const hitsByUid = new Map();
const lastOkByUid = new Map();
let globalHits = [];

function prune(arr, windowMs, now) {
  return arr.filter(t => now - t < windowMs);
}

function checkSoftLimits(uid) {
  const now = Date.now();
  globalHits = prune(globalHits, DAY_MS, now);
  if (globalHits.length >= MAX_GLOBAL_PER_DAY) {
    return { limited: true, status: 429, error: 'Daily service capacity reached. Try again tomorrow.', retryAfter: 3600 };
  }

  const lastOk = lastOkByUid.get(uid) || 0;
  if (now - lastOk < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - lastOk)) / 1000);
    return { limited: true, status: 429, error: `Please wait ${wait}s before another analysis.`, retryAfter: wait };
  }

  let hits = prune(hitsByUid.get(uid) || [], MINUTE_MS, now);
  if (hits.length >= MAX_PER_MINUTE) {
    return { limited: true, status: 429, error: 'Limit: 1 analysis per minute. Please wait.', retryAfter: 60 };
  }

  hits.push(now);
  hitsByUid.set(uid, hits);
  globalHits.push(now);
  return { limited: false };
}

function emailHash(email) {
  const salt = process.env.IP_HASH_SALT || 'langcanvas';
  return createHash('sha256').update(String(email || '') + salt).digest('hex').slice(0, 16);
}

function tracingEnabled() {
  return Boolean(process.env.LANGSMITH_API_KEY);
}

function normalizePrivateKey(raw) {
  let privateKey = String(raw || '').trim();
  if (
    (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
    (privateKey.startsWith("'") && privateKey.endsWith("'"))
  ) {
    privateKey = privateKey.slice(1, -1);
  }
  // Vercel / .env often store PEM with literal \n sequences
  privateKey = privateKey.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  return privateKey.trim();
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
  // UUID v4-ish or opaque token 16–64 chars
  if (/^[a-f0-9-]{16,64}$/i.test(s)) return s.toLowerCase();
  return null;
}

function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/**
 * Lifetime guest quota.
 * Primary key: stable browser guest id (survives refresh).
 * Also tracks IP so clearing localStorage cannot fully reset the trial.
 */
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
        `Free trial limit reached (${GUEST_LIMIT} AI critiques). Sign in / subscribe for more.`,
      );
      err.status = 429;
      err.code = 'quota_exceeded';
      err.plan = 'guest';
      err.limit = GUEST_LIMIT;
      err.used = used;
      throw err;
    }

    const next = used + 1;
    const payload = {
      count: next,
      limit: GUEST_LIMIT,
      plan: 'guest',
      updatedAt: now,
    };

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

    return {
      uid: guestKey ? `guest:${guestKey}` : `guest-ip:${ipKey}`,
      email: '',
      plan: 'guest',
      limit: GUEST_LIMIT,
      used: next,
      remaining: Math.max(0, GUEST_LIMIT - next),
    };
  });
}

async function ensureUserAndReserveQuota(decoded) {
  const db = getDb();
  const uid = decoded.uid;
  const email = decoded.email || '';
  const day = utcDay();
  const userRef = db.collection('users').doc(uid);
  const usageRef = db.collection('usage').doc(`${uid}_${day}`);

  try {
    return await db.runTransaction(async (tx) => {
      // Firestore requires all reads before any writes in a transaction.
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
            ? `Daily Pro limit reached (${limit} analyses). Try again tomorrow.`
            : `Free plan limit reached (${limit} analyses / day). Upgrade to Pro for a higher daily quota.`,
        );
        err.status = 429;
        err.code = 'quota_exceeded';
        err.plan = plan;
        err.limit = limit;
        err.used = count;
        throw err;
      }

      const next = count + 1;
      tx.set(usageRef, {
        uid,
        date: day,
        count: next,
        plan,
        updatedAt: now,
      }, { merge: true });

      return { uid, email, plan, limit, used: next, remaining: Math.max(0, limit - next) };
    });
  } catch (err) {
    if (err && err.status) throw err;
    throw err;
  }
}

async function callGeminiRaw(prompt) {
  const { text, model } = await generateGeminiText({
    system: SYSTEM_PROMPT,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    temperature: 0.3,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  return { text, model };
}

const tracedGeminiAnalyze = traceable(
  async function langcanvasGeminiAnalyze({ prompt }) {
    return callGeminiRaw(prompt);
  },
  {
    name: 'langcanvas-analyze',
    run_type: 'chain',
    tags: ['langcanvas', 'analyze'],
  },
);

async function runAnalyze(prompt, meta) {
  if (!tracingEnabled()) {
    return callGeminiRaw(prompt);
  }

  return tracedGeminiAnalyze(
    { prompt },
    {
      metadata: {
        ...meta,
        model: 'gemini-flash-lite',
      },
      tags: ['langcanvas', 'analyze'],
    },
  );
}

function summarizeGraph(graph) {
  if (!graph || typeof graph !== 'object') return {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  return {
    node_count: nodes.length,
    edge_count: edges.length,
    node_types: nodes.reduce((acc, n) => {
      const t = n && n.type ? String(n.type) : 'unknown';
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {}),
    problem: typeof graph.problem === 'string' ? graph.problem.slice(0, 500) : undefined,
    graph_snapshot: {
      nodes: nodes.map(n => ({ id: n.id, type: n.type, label: n.label })),
      edges: edges.map(e => ({ from: e.from, to: e.to, label: e.label || '' })),
      stateVars: Array.isArray(graph.stateVars) ? graph.stateVars.slice(0, 20) : [],
    },
  };
}

async function flushTraces() {
  if (!tracingEnabled()) return;
  try {
    const client = new Client();
    await client.awaitPendingTraceBatches();
  } catch (_) { /* ignore */ }
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

  const softKey = decoded ? decoded.uid : `ip:${ipHash(clientIp(req))}`;
  const soft = checkSoftLimits(softKey);
  if (soft.limited) {
    res.setHeader('Retry-After', String(soft.retryAfter || 60));
    return res.status(soft.status).json({ error: soft.error });
  }

  let prompt;
  let clientMeta = {};
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    prompt = body && body.prompt;
    if (body && body.metadata && typeof body.metadata === 'object') clientMeta = body.metadata;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid body: expected JSON with { prompt }.' });
  }
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing "prompt" field.' });
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: `Prompt too long (max ${MAX_PROMPT_CHARS} characters).` });
  }

  let quota;
  try {
    quota = decoded ? await ensureUserAndReserveQuota(decoded) : await reserveGuestQuota(req);
  } catch (err) {
    if (err && err.status === 429) {
      res.setHeader('Retry-After', '3600');
      return res.status(429).json({
        error: err.message,
        code: err.code || 'quota_exceeded',
        plan: err.plan,
        limit: err.limit,
        used: err.used,
      });
    }
    const detail = [err && err.code, err && err.message, String(err)]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 400);
    console.error('quota_check_failed', detail);
    return res.status(500).json({ error: 'Could not check usage quota.', detail });
  }

  const graphSummary = summarizeGraph(clientMeta.graph);
  const traceMeta = {
    uid: quota.uid,
    email_hash: emailHash(quota.email),
    plan: quota.plan,
    problem: typeof clientMeta.problem === 'string' ? clientMeta.problem.slice(0, 500) : graphSummary.problem,
    node_count: graphSummary.node_count,
    edge_count: graphSummary.edge_count,
    node_types: graphSummary.node_types,
    graph_snapshot: graphSummary.graph_snapshot,
  };

  try {
    const result = await runAnalyze(prompt, traceMeta);
    lastOkByUid.set(softKey, Date.now());
    await flushTraces();
    return res.status(200).json({
      text: result.text,
      usage: { plan: quota.plan, used: quota.used, limit: quota.limit, remaining: quota.remaining },
    });
  } catch (err) {
    await flushTraces();
    if (err && err.status === 502) {
      return res.status(502).json({ error: err.message || 'AI provider error.', detail: err.detail });
    }
    return res.status(500).json({ error: 'Unexpected error calling the AI.', detail: String(err).slice(0, 300) });
  }
}
