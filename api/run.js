// POST /api/run — execute a LangCanvas graph (live LLM + catalog tools).
// One quota unit per full run (same buckets as assistant/analyze).

import { createHash } from 'node:crypto';
import admin from 'firebase-admin';
import { generateGeminiJson, fieldsToGeminiSchema, readResponseJson } from '../lib/gemini.js';
import { runGraph } from '../lib/run-graph.js';

export const config = { maxDuration: 60 };

const PLAN_LIMITS = { free: 5, pro: 50, guest: 5 };
const GUEST_LIMIT = PLAN_LIMITS.guest;
const MAX_INPUT = 800;
const MAX_GRAPH_CHARS = 40000;
const COOLDOWN_MS = 8 * 1000;
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

function fieldsPrompt(fields) {
  return (fields || []).map(f => {
    const t = String(f.type || 'str');
    if (t.indexOf('schema:') === 0) {
      const inner = (f.nestedFields || []).map(n => n.key + ': str').join(', ');
      return '- ' + f.key + ': object' + (inner ? ' { ' + inner + ' }' : '') + (f.desc ? ' — ' + f.desc : '');
    }
    return '- ' + f.key + ': ' + t + (f.desc ? ' — ' + f.desc : '');
  }).join('\n');
}

function formatThread(messages) {
  return (messages || []).slice(-6).map(m => {
    const role = m.role === 'assistant' || m.kind === 'llm' ? 'model' : 'user';
    const body = m.role === 'tool'
      ? ('TOOL RESULT:\n' + (m.content || ''))
      : (m.args ? JSON.stringify(m.args) : (m.content || ''));
    return (role === 'model' ? 'model' : 'user') + ': ' + String(body).slice(0, 1800);
  }).join('\n---\n').slice(0, 5000);
}

async function liveLlm({ system, schemaName, fields, messages, input, prompt, promptTemplate, temperature }) {
  const schemaBlock = schemaName
    ? ('Fill this JSON object (' + schemaName + '):\n' + fieldsPrompt(fields) + '\n')
    : 'Return JSON { "answer": "..." }.\n';
  const filled = String(prompt || '').trim();
  const template = String(promptTemplate || '');
  let userText = '';
  if (filled) {
    userText = filled + '\n\n' + schemaBlock;
    const alreadyHasThread = /\{messages\}/i.test(template) || /^(user|model|assistant|tool):/m.test(filled);
    if (!alreadyHasThread && messages && messages.length) {
      userText += '\nThread so far:\n' + formatThread(messages);
    }
  } else {
    userText = 'User input: ' + (input || '') + '\n\n' + schemaBlock;
    if (messages && messages.length) userText += '\nThread so far:\n' + formatThread(messages);
  }
  const schema = (fields && fields.length) ? fieldsToGeminiSchema(fields) : {
    type: 'OBJECT',
    properties: { answer: { type: 'STRING' } },
    required: ['answer'],
  };
  const temp = Number(temperature);
  const { data } = await generateGeminiJson({
    system: system || 'You are a node in a LangGraph agent. Fill the schema from the thread.',
    userText,
    temperature: Number.isFinite(temp) ? temp : 0.2,
    maxOutputTokens: 4096,
    responseSchema: schema,
  });
  return data && typeof data === 'object' ? data : { answer: String(data) };
}

async function searchDuckDuckGo(query) {
  try {
    const url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1';
    const res = await fetch(url, { headers: { 'User-Agent': 'LangCanvas/1.0' } });
    if (!res.ok) return '';
    const data = await readResponseJson(res);
    if (!data) return '';
    const bits = [];
    if (data.AbstractText) bits.push(data.AbstractText);
    (data.RelatedTopics || []).slice(0, 3).forEach(t => {
      if (t && t.Text) bits.push(t.Text);
      else if (t && t.Topics && t.Topics[0] && t.Topics[0].Text) bits.push(t.Topics[0].Text);
    });
    return bits.join(' ').slice(0, 800);
  } catch (_) {
    return '';
  }
}

async function searchWikipedia(query) {
  try {
    const url = 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(query.replace(/\s+/g, '_'));
    const res = await fetch(url, { headers: { 'User-Agent': 'LangCanvas/1.0' } });
    if (!res.ok) return '';
    const data = await readResponseJson(res);
    return data ? String(data.extract || data.description || '').slice(0, 800) : '';
  } catch (_) {
    return '';
  }
}

async function searchTavily(query) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: 3, search_depth: 'basic' }),
    });
    if (!res.ok) return null;
    const data = await readResponseJson(res);
    if (!data) return null;
    const rows = data.results || [];
    return rows.map(r => (r.title ? r.title + ': ' : '') + (r.content || r.snippet || '')).join('\n').slice(0, 1200);
  } catch (_) {
    return null;
  }
}

async function liveTool({ toolId, queries }) {
  const qlist = (queries && queries.length) ? queries.slice(0, 3) : ['(empty)'];
  const out = [];
  for (const q of qlist) {
    let snippet = '';
    let source = toolId;
    if (toolId === 'python_repl') {
      snippet = 'Python REPL is not executed on LangCanvas (unsafe). Export the graph to run code.';
      source = 'blocked';
    } else if (toolId === 'wikipedia') {
      snippet = (await searchWikipedia(q)) || (await searchDuckDuckGo(q));
    } else if (toolId === 'tavily') {
      const tv = await searchTavily(q);
      if (tv) {
        snippet = tv;
        source = 'tavily';
      } else {
        snippet = (await searchDuckDuckGo(q)) || (await searchWikipedia(q));
        source = snippet ? 'duckduckgo-fallback' : 'empty';
      }
    } else {
      snippet = (await searchDuckDuckGo(q)) || (await searchWikipedia(q));
      source = snippet ? 'duckduckgo' : 'empty';
    }
    out.push({
      query: q,
      snippet: snippet || 'No snippet returned for this query.',
      source,
    });
  }
  return out;
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

  const uidKey = decoded ? decoded.uid : 'ip:' + ipHash(clientIp(req));
  const lastOk = lastOkByUid.get(uidKey) || 0;
  const now = Date.now();
  if (now - lastOk < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - lastOk)) / 1000);
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'Please wait ' + wait + 's before another run.' });
  }

  let input = '';
  let graph = null;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    input = String((body && body.input) || '').trim().slice(0, MAX_INPUT);
    if (body && body.graph && typeof body.graph === 'object') graph = body.graph;
  } catch (_) {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  if (!input) {
    return res.status(400).json({ error: 'Missing input.' });
  }
  if (!graph || !Array.isArray(graph.nodes)) {
    return res.status(400).json({ error: 'Missing graph.' });
  }
  if (JSON.stringify(graph).length > MAX_GRAPH_CHARS) {
    return res.status(400).json({ error: 'Graph is too large to run.' });
  }

  try {
    if (decoded) await ensureUserAndReserveQuota(decoded);
    else await reserveGuestQuota(req);
  } catch (err) {
    if (err && err.status === 429) {
      res.setHeader('Retry-After', '3600');
      return res.status(429).json({ error: err.message, code: err.code || 'quota_exceeded' });
    }
    console.error('run_quota_failed', err && err.message);
    return res.status(500).json({ error: 'Could not check usage quota.' });
  }

  try {
    const result = await runGraph(graph, input, { llm: liveLlm, tool: liveTool });
    lastOkByUid.set(uidKey, Date.now());
    const trace = (result.trace || []).map(step => {
      const copy = { ...step };
      if (Array.isArray(copy.messages)) {
        copy.thread = copy.messages.map(m => m.role || m.kind || '?');
        copy.messages = copy.messages.slice(-2).map(m => ({
          role: m.role,
          content: String(m.content || '').slice(0, 600),
        }));
      }
      delete copy.reads;
      if (copy.llm && copy.llm.prompt) copy.llm.prompt = String(copy.llm.prompt).slice(0, 800);
      return copy;
    });
    return res.status(200).json({
      live: true,
      trace,
      outputs: result.outputs,
      error: result.error || '',
    });
  } catch (err) {
    console.error('run_failed', err && err.message, err && err.detail);
    return res.status(err.status || 502).json({ error: err.message || 'Run failed.', detail: err.detail || '' });
  }
}
