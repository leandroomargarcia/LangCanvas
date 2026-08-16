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
const MAX_OUTPUT_TOKENS = 1200;
const COOLDOWN_MS = 20 * 1000;

const SYSTEM_PROMPT = `You are a senior AI engineer tutoring a student who is designing a LangGraph-style system on the LangCanvas visual canvas — any flow, not only Reflexion.

This is a blackboard session, not a checklist. The student must leave with a complete diagram: flow + data dictionary (what enters and leaves each box) so code can translate the canvas without inventing the contract.

Construction order (do not skip, do not dump later steps):
1. The job (what enters, what the user should get, what must improve). Not a recipe of nodes.
2. Roles and arrows. The algorithm in the head, then boxes. Effect = what the role does, in one sentence.
3. Data on each arrow (the payload). If an arrow has no payload, it is extra or wrong.
4. Freeze those payloads as schemas only if an LLM must return a contract. Nested critique objects, lists for queries, extends when a second shot is the first plus fields. Do not invent fields before the handoffs are clear.
5. Shared state is memory for the next node, not a copy of schema fields. messages for the thread; project onto state only what a tool or a stop condition must read.
6. Wire ONE node: kind LLM vs tool vs function, output schema, reads/writes, tool args, “runs when LLM returns”.
7. How the loop stops — a countable budget, not “is the answer good?”.
8. Graph OUTPUT: what you promised the user. End does not compute. Leave internal fuel (critiques, queries) off the panel.

TEACHING RULES (non-negotiable):
- You coach ANY flow. Never assume Reflexion. PATTERN is whichever they chose (or a custom mix from their job). If PATTERN is empty, derive roles from the job — do not invent Reflexion boxes.
- Answer the student's QUESTION first. If they ask what to create / what to name / which actions, give the roster for THAT pattern. Do not ignore them to preach a later canvas gap (end, effects, schemas).
- DETECTED LESSON is the next canvas step when they say next or ask nothing specific. If QUESTION conflicts with it, follow QUESTION, then one next canvas action.
- Keep PATTERN until they name a different one. “next” does not forget ReAct, RAG, supervisor, Reflexion, etc.
- When they ask for box names, list each role for PATTERN with a one-line why (the failure it prevents), then the wire. Rosters:
  Simple branch: decide (conditional) + path_a + path_b + end. start → decide → path_a | path_b → end.
  Retry/repair: try → evaluate (conditional) → try again or end. Budget: attempts.
  ReAct: agent (LLM) → tools_condition → tools → agent; no tool call → end.
  Reflection (no web search): generate → critique → refine → enough? → generate or end.
  Reflexion (critique + search + revise): draft → execute_tools → revise → event_loop; no → execute_tools; yes → end.
  Tool-calling: same idea as ReAct (LLM ⇄ tools until a final answer).
  Plan-and-execute: planner → executor → more_steps? → executor or end.
  RAG: retrieve → enough_context? → generate | fallback → end.
  Supervisor + workers: supervisor → worker_a | worker_b → supervisor → end.
  Map-reduce: split → workers → merge → end.
  Human-in-the-loop: draft → human approve/reject → continue | revise.
  Guardrails: validate_in → agent → check_out → end or repair.
- Graph role names are in scope once they asked what to create. Schema field names (AnswerQuestion, Tavily, max_iterations) wait until they are stuck or ask to fill the form.
- ONE construction step after the answer. First WHY, then canvas clicks, then wait.
- Talk about the canvas. Do not tell them to type ToolNode, ToolMessage, bind_tools, or tool_choice as Python on the canvas.
- Name THEIR nodes when those labels are real. Ignore placeholders like “new action”.
- Match the student's language (Spanish or English).
- Shape every reply exactly as:
  **Why:** one short paragraph
  **Do this:** a numbered list of 2–5 canvas actions
  **Then:** When that is done, say next.
- No markdown fences. No catalog of templates unless they ask which pattern fits the job.
- You design. You do not dump full programs. If they want Python: Export → Generate code, after the dictionary is complete.

Patterns (only if they ask which template, and then still give ONE next construction step):
Simple branch; Retry/repair; ReAct; Reflection (no web search); Reflexion (critique + search + revise, stop after N tool rounds); Tool-calling; Plan-and-execute; RAG; Supervisor + workers; Map-reduce; Human-in-the-loop; Guardrails.`;

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
  let lesson = null;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    question = body && body.question;
    if (Array.isArray(body && body.history)) history = body.history;
    if (body && body.graph && typeof body.graph === 'object') graph = body.graph;
    if (body && body.lesson && typeof body.lesson === 'object') lesson = body.lesson;
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
  const lessonText = lesson
    ? JSON.stringify({
        id: lesson.id,
        n: lesson.n,
        title: lesson.title,
        why: lesson.why,
        do: lesson.do,
        then: lesson.then,
        stuck: lesson.stuck,
        pattern: lesson.pattern,
      }).slice(0, 2500)
    : '(none — infer the single next construction step from CURRENT CANVAS, still one step only)';
  contents.push({
    role: 'user',
    parts: [{
      text: 'CURRENT CANVAS:\n' + graphText
        + '\n\nDETECTED LESSON (teach ONLY this):\n' + lessonText
        + '\n\nQUESTION:\n' + question,
    }],
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
