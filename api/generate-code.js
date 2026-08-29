// Vercel Serverless Function: POST /api/generate-code
// Auth + freemium quota. Uses LangChain docs/reference MCP for up-to-date APIs.

import admin from 'firebase-admin';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generateGeminiText } from '../lib/gemini.js';
import { isUnlimitedEmail } from '../lib/quota.js';
import { filledClauses, formatPredicate, pythonPredicate } from '../lib/predicate.js';

export const config = { maxDuration: 60 };

const PLAN_LIMITS = { free: 5, pro: 50 };
const MAX_GRAPH_JSON = 12000;
const MAX_OUTPUT_TOKENS = 3500;
const DOCS_MCP = 'https://docs.langchain.com/mcp';
const REF_MCP = 'https://reference.langchain.com/mcp';

const SYSTEM_PROMPT = `You translate a LangCanvas visual graph into working LangGraph Python code.

CRITICAL MAPPING RULES (LangCanvas → LangGraph):
1. Use each node's "label" as the Python symbol / add_node name (snake_case). NEVER use internal ids like action_1, router_2, n_3.
2. type "action" → real graph node via builder.add_node("label", fn).
3. type "router" / conditional → NOT an add_node. It becomes a routing function used only in add_conditional_edges from its predecessor(s). If the spec gives python_when (including and / or / not state.get(...) for is-empty), use that exact test in the route function.
4. type "start" → START / set_entry_point on the first real action after start. Do not add_node("start").
5. type "end" → END constant. Do not add_node("end").
6. Edge A→router with branches router→B / router→C means:
   builder.add_conditional_edges("A", route_fn, {"branch": "B", ...})
   where route_fn returns the branch labels (or END).
7. Never write add_edge("generate", "should_continue") then treat should_continue as a node.
8. Prefer current LangGraph APIs from the MCP docs context.
9. Implement node bodies from "effect" / problem description (LLM calls when it makes sense). English only.
10. If an action has detail.kind "tool":
    - detail.toolId is a catalog id (tavily, wikipedia, duckduckgo, python_repl) → import that LangChain tool and wire args from detail.toolArgs (param ← state key fromKey).
    - detail.toolId "custom" (or unknown) → emit an @tool stub named detail.tool with detail.toolDesc and toolArgs; raise NotImplementedError in the body.
    Tools are design-time only; still generate real Python that compiles.
11. If the graph has a "schemas" array, emit those as Pydantic models in schemas.py (fields, types, Field descriptions, extendsId inheritance). LLM nodes with detail.outputSchemaId must bind_tools(tools=[ThatModel], tool_choice="ThatModel") when detail.bindTools is true.
12. If a tool node has detail.handlesSchemaIds, it runs when the LLM returns those Pydantic models. Emit ToolNode([StructuredTool.from_function(fn, name=Model.__name__) for each handled schema]). Do not mention ToolNode in comments as a canvas concept — it is codegen only.
13. Tool invoke vs batch: if the shared-state key in toolArgs.fromKey has type "list" or "list[str]", call tool.batch([{param: item} for item in state[fromKey]]); otherwise tool.invoke({param: state[fromKey]}).
14. Router detail.stopMode "tool_rounds": stop when sum(isinstance(m, ToolMessage) for m in state["messages"]) >= N. N is detail.stopMax as a literal, or the initial value of that shared-state key. Branch "si" = stop, "no" = continue. Do not require a tool_visits counter in state.
15. Graph "outputs" array is what the compiled graph should print from the last AIMessage tool call: each {key, schemaId, field} maps to args.get("field").
16. Output plain Python only. Multi-file: "# chains.py" / "# main.py" headers. No markdown fences. No trailing junk.`;

const hitsByUid = new Map();
const lastOkByUid = new Map();
const COOLDOWN_MS = 45 * 1000;

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

function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function checkSoftLimits(uid) {
  const now = Date.now();
  const lastOk = lastOkByUid.get(uid) || 0;
  if (now - lastOk < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - lastOk)) / 1000);
    return { limited: true, status: 429, error: `Please wait ${wait}s before another code generation.`, retryAfter: wait };
  }
  let hits = (hitsByUid.get(uid) || []).filter(t => now - t < 60_000);
  if (hits.length >= 2) {
    return { limited: true, status: 429, error: 'Limit: 2 code generations per minute.', retryAfter: 60 };
  }
  hits.push(now);
  hitsByUid.set(uid, hits);
  return { limited: false };
}

async function ensureUserAndReserveQuota(decoded) {
  const db = getDb();
  const uid = decoded.uid;
  const email = decoded.email || '';
  const day = utcDay();
  const userRef = db.collection('users').doc(uid);
  const usageRef = db.collection('usage').doc(`${uid}_${day}`);

  return db.runTransaction(async (tx) => {
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
      const next = count + 1;
      tx.set(usageRef, {
        uid, date: day, count: next, plan: 'unlimited', updatedAt: now,
      }, { merge: true });
      return { uid, email, plan: 'unlimited', limit: null, used: next, remaining: null };
    }

    const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const count = usageSnap.exists ? Number(usageSnap.data().count || 0) : 0;
    if (count >= limit) {
      const err = new Error(
        plan === 'pro'
          ? `Daily Pro limit reached (${limit} AI actions). Try again tomorrow.`
          : `Free plan limit reached (${limit} AI actions / day). Upgrade to Pro for a higher daily quota.`,
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
}

function toolText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts
    .map((p) => (p && p.type === 'text' ? p.text : typeof p === 'string' ? p : JSON.stringify(p)))
    .filter(Boolean)
    .join('\n')
    .slice(0, 6000);
}

async function withMcp(url, fn) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'langcanvas-codegen', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function buildSearchPlan(pattern, graph) {
  const labels = (graph?.nodes || []).map((n) => n.label).filter(Boolean).join(', ');
  const docsQueries = [];
  const apiQueries = [];

  if (pattern === 'react') {
    docsQueries.push('LangGraph ReAct agent ToolNode tools_condition Python');
    apiQueries.push('ToolNode tools_condition');
    apiQueries.push('StateGraph add_conditional_edges');
  } else if (pattern === 'reflection') {
    docsQueries.push('LangGraph reflection agent generate critique loop Python');
    apiQueries.push('StateGraph add_conditional_edges END');
    apiQueries.push('add_messages Annotated MessagesState');
  } else if (pattern === 'reflexion') {
    docsQueries.push('LangGraph Reflexion agent draft tools revise loop Python');
    apiQueries.push('ToolNode add_conditional_edges StateGraph');
    apiQueries.push('add_messages MessagesState bind_tools');
  } else {
    docsQueries.push(`LangGraph StateGraph Python ${labels}`.slice(0, 120));
    apiQueries.push('StateGraph add_node add_edge add_conditional_edges compile');
  }

  return { docsQueries, apiQueries };
}

async function gatherMcpContext(pattern, graph) {
  const { docsQueries, apiQueries } = buildSearchPlan(pattern, graph);
  const chunks = [];

  await Promise.all([
    withMcp(DOCS_MCP, async (client) => {
      for (const query of docsQueries.slice(0, 2)) {
        try {
          const r = await client.callTool({
            name: 'search_docs_by_lang_chain',
            arguments: { query },
          });
          chunks.push(`### Docs: ${query}\n${toolText(r)}`);
        } catch (e) {
          chunks.push(`### Docs error (${query}): ${String(e.message || e).slice(0, 200)}`);
        }
      }
    }),
    withMcp(REF_MCP, async (client) => {
      for (const query of apiQueries.slice(0, 2)) {
        try {
          const r = await client.callTool({
            name: 'search_api',
            arguments: { query, language: 'python', limit: 5 },
          });
          chunks.push(`### API reference: ${query}\n${toolText(r)}`);
        } catch (e) {
          chunks.push(`### API error (${query}): ${String(e.message || e).slice(0, 200)}`);
        }
      }
    }),
  ]);

  return chunks.join('\n\n').slice(0, 18000);
}

function pyName(label, fallback) {
  const s = String(label || fallback || 'node')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || String(fallback || 'node');
}

/** Explicit wiring plan so the model cannot invent action_1 / router_2 names. */
function buildCodeSpec(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const stateVars = Array.isArray(graph?.stateVars) ? graph.stateVars : [];

  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const nameOf = {};
  const used = new Set();
  for (const n of nodes) {
    if (n.type === 'start') {
      nameOf[n.id] = 'START';
      continue;
    }
    if (n.type === 'end') {
      nameOf[n.id] = 'END';
      continue;
    }
    let base = pyName(n.label, n.id);
    let name = base;
    let i = 2;
    while (used.has(name)) {
      name = `${base}_${i++}`;
    }
    used.add(name);
    nameOf[n.id] = name;
  }

  const actions = nodes
    .filter((n) => n.type === 'action')
    .map((n) => ({
      name: nameOf[n.id],
      label: n.label,
      effect: n.effect || '',
    }));

  const routers = nodes
    .filter((n) => n.type === 'router')
    .map((n) => {
      const outs = edges
        .filter((e) => e.from === n.id)
        .map((e) => {
          const to = byId[e.to];
          const target =
            to?.type === 'end' ? 'END' : nameOf[e.to];
          const branch = (e.label || '').trim() || target;
          return { branch, target };
        });
      const preds = edges
        .filter((e) => e.to === n.id)
        .map((e) => {
          const from = byId[e.from];
          if (!from || from.type === 'start') return 'START';
          if (from.type === 'router') return null;
          return nameOf[e.from];
        })
        .filter(Boolean);
      const d = n.detail || {};
      return {
        name: nameOf[n.id],
        label: n.label,
        effect: n.effect || '',
        route_fn: `route_${nameOf[n.id]}`,
        when: formatPredicate(d) || '',
        python_when: filledClauses(d).length ? pythonPredicate(d) : '',
        join: d.predJoin === 'or' ? 'or' : 'and',
        predecessors: [...new Set(preds)],
        branches: outs,
      };
    });

  const plainEdges = [];
  for (const e of edges) {
    const from = byId[e.from];
    const to = byId[e.to];
    if (!from || !to) continue;
    if (from.type === 'router' || to.type === 'router') continue;
    const fromName = from.type === 'start' ? 'START' : nameOf[e.from];
    const toName = to.type === 'end' ? 'END' : nameOf[e.to];
    if (fromName === 'START' && to.type === 'action') {
      plainEdges.push({ from: 'START', to: toName, note: 'entry' });
    } else if (from.type === 'action' && to.type === 'action') {
      plainEdges.push({ from: fromName, to: toName });
    } else if (from.type === 'action' && to.type === 'end') {
      plainEdges.push({ from: fromName, to: 'END' });
    }
  }

  return {
    problem: typeof graph?.problem === 'string' ? graph.problem.slice(0, 500) : '',
    stateVars: stateVars.map((v) => ({ key: v.key, val: v.val })).slice(0, 30),
    add_nodes: actions,
    routers_as_conditional_edges_only: routers,
    plain_edges: plainEdges,
    rules: [
      'ONLY add_node for add_nodes[].name',
      'Routers are NOT nodes — use routers_as_conditional_edges_only',
      'For each router, from each predecessor call add_conditional_edges(pred, route_fn, mapping)',
      'Mapping keys = branch labels; values = target node name or END',
      'Do not reference internal canvas ids',
    ],
  };
}

function summarizeGraph(graph) {
  return buildCodeSpec(graph);
}

function stripFences(text) {
  let t = String(text || '').trim();
  // Remove markdown fences and a trailing lone + / junk
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:python)?\s*/i, '').replace(/\s*```$/i, '');
  }
  t = t.replace(/\n\+\s*$/g, '').trim();
  return t;
}

function validateGeneratedCode(code, spec) {
  const problems = [];
  if (!code || code.length < 40) problems.push('code too short');
  if (/\baction_\d+\b/.test(code) || /\brouter_\d+\b/.test(code) || /\bn_\d+\b/.test(code)) {
    problems.push('uses internal canvas ids (action_N / router_N) instead of labels');
  }
  if (/\+\s*$/.test(code)) problems.push('trailing junk');

  for (const a of spec.add_nodes || []) {
    const re = new RegExp(`add_node\\(\\s*["']${a.name}["']`);
    if (!re.test(code)) problems.push(`missing add_node("${a.name}")`);
  }
  for (const r of spec.routers_as_conditional_edges_only || []) {
    const asNode = new RegExp(`add_node\\(\\s*["']${r.name}["']`);
    if (asNode.test(code)) {
      problems.push(`router "${r.name}" must NOT be add_node — use add_conditional_edges only`);
    }
    if (!/add_conditional_edges\s*\(/.test(code) && (r.branches || []).length) {
      problems.push('missing add_conditional_edges for router');
    }
  }
  return problems;
}

async function callGeminiCodegen(userPrompt) {
  const { text } = await generateGeminiText({
    system: SYSTEM_PROMPT,
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    temperature: 0.15,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  return stripFences(text);
}

function buildUserPrompt(pattern, spec, mcpContext, repairNotes) {
  let prompt =
    `Pattern hint (optional): ${pattern}\n\n` +
    `CODE_SPEC (authoritative — follow exactly):\n${JSON.stringify(spec, null, 2)}\n\n` +
    `LIVE LANGCHAIN/LANGGRAPH DOCS (from MCP):\n${mcpContext || '(no MCP context)'}\n\n`;
  if (repairNotes?.length) {
    prompt +=
      `PREVIOUS OUTPUT WAS INVALID. Fix these issues:\n- ${repairNotes.join('\n- ')}\n\n` +
      'Regenerate the full corrected Python code.\n';
  } else {
    prompt += 'Generate the full Python implementation now from CODE_SPEC.\n';
  }
  return prompt;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  if (!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    return res.status(500).json({ error: 'Server missing GEMINI_API_KEY.' });
  }

  let decoded;
  try {
    decoded = await verifyBearer(req);
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message || 'Sign in required.' });
  }

  const soft = isUnlimitedEmail(decoded.email)
    ? { limited: false }
    : checkSoftLimits(decoded.uid);
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

  const graph = body?.graph;
  const pattern = typeof body?.pattern === 'string' ? body.pattern : 'generic';
  if (!graph || typeof graph !== 'object') {
    return res.status(400).json({ error: 'Missing "graph" object.' });
  }
  const spec = buildCodeSpec(graph);
  const graphJson = JSON.stringify(spec);
  if (graphJson.length > MAX_GRAPH_JSON) {
    return res.status(400).json({ error: 'Graph too large to generate code.' });
  }

  let quota;
  try {
    quota = await ensureUserAndReserveQuota(decoded);
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
    return res.status(500).json({
      error: 'Could not check usage quota.',
      detail: [err?.code, err?.message, String(err)].filter(Boolean).join(' | ').slice(0, 400),
    });
  }

  try {
    const mcpContext = await gatherMcpContext(pattern, graph);
    let code = await callGeminiCodegen(buildUserPrompt(pattern, spec, mcpContext));
    let problems = validateGeneratedCode(code, spec);

    if (problems.length) {
      console.warn('codegen_retry', problems.join('; '));
      code = await callGeminiCodegen(buildUserPrompt(pattern, spec, mcpContext, problems));
      problems = validateGeneratedCode(code, spec);
    }

    if (problems.length) {
      return res.status(502).json({
        error: 'Generated code failed validation.',
        detail: problems.join('; ').slice(0, 400),
        fallback: true,
      });
    }

    lastOkByUid.set(decoded.uid, Date.now());

    return res.status(200).json({
      code,
      source: 'mcp',
      model: 'gemini-flash-lite',
      pattern,
      usage: {
        plan: quota.plan,
        used: quota.used,
        limit: quota.limit,
        remaining: quota.remaining,
      },
    });
  } catch (err) {
    console.error('generate_code_failed', String(err?.message || err).slice(0, 400));
    return res.status(err.status || 500).json({
      error: 'Could not generate code from live docs.',
      detail: String(err?.detail || err?.message || err).slice(0, 400),
      fallback: true,
    });
  }
}
