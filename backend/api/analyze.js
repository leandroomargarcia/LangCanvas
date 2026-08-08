// Vercel Serverless Function: POST /api/analyze
// Gemini design critique + optional LangSmith tracing.
// Rate limits are best-effort in-memory (serverless recycles instances).

import { createHash } from 'node:crypto';
import { Client } from 'langsmith';
import { traceable } from 'langsmith/traceable';

const MODEL = 'gemini-flash-lite-latest';
const SYSTEM_PROMPT =
  'You are an expert in designing agents with LangGraph. Give a short, concrete, practical design critique in English (max ~8 bullet points).';

// Aggressive public-demo limits
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_MINUTE = 1;
const MAX_PER_DAY = 5;
const MAX_GLOBAL_PER_DAY = 80;
const MAX_PROMPT_CHARS = 4000;
const MAX_OUTPUT_TOKENS = 500;
const COOLDOWN_MS = 90 * 1000;

const hitsByIp = new Map();
const lastOkByIp = new Map();
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

function anonVisitor(ip) {
  const salt = process.env.IP_HASH_SALT || 'langcanvas';
  return createHash('sha256').update(String(ip) + salt).digest('hex').slice(0, 16);
}

function tracingEnabled() {
  return Boolean(process.env.LANGSMITH_API_KEY);
}

async function callGeminiRaw(prompt) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('Server missing GEMINI_API_KEY.');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const geminiRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    }),
  });

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    const err = new Error('AI provider error.');
    err.status = 502;
    err.detail = errText.slice(0, 300);
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
  return text;
}

const tracedGeminiAnalyze = traceable(
  async function langcanvasGeminiAnalyze({ prompt }) {
    const text = await callGeminiRaw(prompt);
    return { text, model: MODEL };
  },
  {
    name: 'langcanvas-analyze',
    run_type: 'chain',
    tags: ['langcanvas', 'analyze'],
  },
);

async function runAnalyze(prompt, meta) {
  if (!tracingEnabled()) {
    const text = await callGeminiRaw(prompt);
    return { text, model: MODEL };
  }

  return tracedGeminiAnalyze(
    { prompt },
    {
      metadata: {
        ...meta,
        model: MODEL,
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
    // Keep a compact graph snapshot for debugging in LangSmith
    graph_snapshot: {
      nodes: nodes.map(n => ({ id: n.id, type: n.type, label: n.label })),
      edges: edges.map(e => ({ from: e.from, to: e.to, label: e.label || '' })),
      stateVars: Array.isArray(graph.stateVars) ? graph.stateVars.slice(0, 20) : [],
    },
  };
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

  if (!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    return res.status(500).json({ error: 'Server missing GEMINI_API_KEY.' });
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

  const graphSummary = summarizeGraph(clientMeta.graph);
  const traceMeta = {
    visitor: anonVisitor(ip),
    problem: typeof clientMeta.problem === 'string' ? clientMeta.problem.slice(0, 500) : graphSummary.problem,
    node_count: graphSummary.node_count,
    edge_count: graphSummary.edge_count,
    node_types: graphSummary.node_types,
    graph_snapshot: graphSummary.graph_snapshot,
  };

  try {
    const result = await runAnalyze(prompt, traceMeta);
    lastOkByIp.set(ip, Date.now());

    if (tracingEnabled()) {
      try {
        const client = new Client();
        await client.awaitPendingTraceBatches();
      } catch (_) {
        // Tracing flush failures should not break the user response.
      }
    }

    return res.status(200).json({ text: result.text });
  } catch (err) {
    if (tracingEnabled()) {
      try {
        const client = new Client();
        await client.awaitPendingTraceBatches();
      } catch (_) { /* ignore */ }
    }
    if (err && err.status === 502) {
      return res.status(502).json({ error: err.message || 'AI provider error.', detail: err.detail });
    }
    return res.status(500).json({ error: 'Unexpected error calling the AI.', detail: String(err).slice(0, 300) });
  }
}
