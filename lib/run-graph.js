// Pure graph runner. Browser and Node import this.
// adapters.llm / adapters.tool are injected (live API or mock).

import { evalPredicate, formatPredicate, isEmptyValue, missingWaitKeys, constValueByKey } from './predicate.js';

export { evalPredicate, formatPredicate };

const MAX_VISITS = 24;
const MAX_LLM = 16;
const MAX_TOOL = 8;

/** Demo corpus for retriever.invoke(...) — Lilian Weng-style RAG topics. */
const DEMO_CORPUS = [
  {
    text: 'Agent memory is the store an LLM agent uses to recall past observations, plans, and tool results. Short-term memory is the current context window; long-term memory is often a vector store the agent queries before acting.',
    tags: ['agent', 'memory', 'vector', 'context'],
  },
  {
    text: 'LLM agents combine a language model with tools. ReAct interleaves reasoning traces and actions. AutoGPT and similar systems loop: plan, act with tools, then observe until a goal is met.',
    tags: ['agent', 'react', 'autogpt', 'tool', 'llm'],
  },
  {
    text: 'Prompt engineering is designing instructions so the model follows a task. Techniques include few-shot examples, chain-of-thought, and role prompts. Small wording changes can shift accuracy a lot.',
    tags: ['prompt', 'engineering', 'few-shot', 'chain'],
  },
  {
    text: 'Adversarial attacks on LLMs include jailbreaks and prompt injections that try to override system instructions. Defenses include input filters, output checks, and least-privilege tools.',
    tags: ['adversarial', 'attack', 'jailbreak', 'injection', 'prompt'],
  },
];

function asInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function nodeById(graph, id) {
  return (graph.nodes || []).find(n => n.id === id) || null;
}

function startNode(graph) {
  return (graph.nodes || []).find(n => n.type === 'start') || null;
}

function outgoing(graph, id) {
  return (graph.edges || []).filter(e => e.from === id);
}

function incoming(graph, id) {
  return (graph.edges || []).filter(e => e.to === id);
}

function waitKeysOf(n) {
  const d = (n && n.detail) || {};
  return Array.isArray(d.waitKeys) ? d.waitKeys.map(k => String(k || '').trim()).filter(Boolean) : [];
}

function lastActionPayload(trace, pred) {
  const label = pred && pred.label;
  if (!label) return null;
  for (let i = (trace || []).length - 1; i >= 0; i--) {
    const row = trace[i];
    if (!row || row.type !== 'action' || row.label !== label) continue;
    const fromNode = (row.messages || []).filter(m => m && m.node === label).slice(-1)[0];
    return {
      args: (row.llm && row.llm.args) || {},
      message: fromNode || (row.messages || []).slice(-1)[0],
      wrote: row.wrote || {},
    };
  }
  return null;
}

function backfillWaitKeys(graph, predIds, keys, state, trace) {
  const missing = missingWaitKeys(state, keys);
  if (!missing.length) return;
  const actionPreds = (predIds || []).map(pid => nodeById(graph, pid)).filter(p => p && p.type === 'action');
  missing.forEach(key => {
    let pred = actionPreds.find(p => ((p.detail && p.detail.writes) || []).some(w => w && w.key === key));
    if (!pred && actionPreds.length === keys.length) pred = actionPreds[keys.indexOf(key)];
    if (!pred) return;
    const payload = lastActionPayload(trace, pred);
    if (!payload) return;
    if (payload.wrote && !isEmptyValue(payload.wrote[key]) && payload.wrote[key] !== '(appended)') {
      state[key] = payload.wrote[key];
      return;
    }
    const v = payloadWriteValue(payload, key);
    if (v !== undefined && !isEmptyValue(v)) state[key] = v;
  });
}

function asFloat(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseStateVal(val, type) {
  const t = String(type || '');
  const s = val == null ? '' : String(val).trim();
  if (t === 'int') return asInt(s, 0);
  if (t === 'float') return asFloat(s, 0);
  if (t === 'bool') return s === 'true' || s === '1';
  if (t === 'list' || t === 'list[str]' || t === 'messages') {
    if (!s || s === '[]') return [];
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : [s];
    } catch (_) {
      return s.split(',').map(x => x.trim()).filter(Boolean);
    }
  }
  return s;
}

export function initRunState(graph, input) {
  const state = {};
  (graph.stateVars || []).forEach(v => {
    const key = (v.key || '').trim();
    if (!key) return;
    state[key] = parseStateVal(v.val, v.type);
  });
  const text = String(input || '').trim();
  if (Object.prototype.hasOwnProperty.call(state, 'messages')) {
    const msgs = Array.isArray(state.messages) ? state.messages.slice() : [];
    if (text) msgs.push({ role: 'user', content: text });
    state.messages = msgs;
  } else if (text) {
    state.messages = [{ role: 'user', content: text }];
  }
  if (text && Object.prototype.hasOwnProperty.call(state, 'question')) state.question = text;
  if (text && Object.prototype.hasOwnProperty.call(state, 'user_input')) state.user_input = text;
  return state;
}

function schemaById(graph, id) {
  return (graph.schemas || []).find(s => s.id === id) || null;
}

export function flattenSchemaFields(graph, schemaId, seen) {
  const s = schemaById(graph, schemaId);
  if (!s) return [];
  const visit = seen || new Set();
  if (visit.has(s.id)) return [];
  visit.add(s.id);
  const parent = s.extendsId ? flattenSchemaFields(graph, s.extendsId, visit) : [];
  const map = {};
  parent.forEach(f => { if (f.key) map[f.key] = f; });
  (s.fields || []).forEach(f => { if (f && f.key) map[f.key] = f; });
  return Object.values(map).map(f => {
    const type = String(f.type || '');
    if (type.indexOf('schema:') === 0) {
      return { ...f, nestedFields: flattenSchemaFields(graph, type.slice('schema:'.length)) };
    }
    return { ...f };
  });
}

function looksOffCorpus(q) {
  return /\b(wimbledon|nba|nfl|mlb|premier league|world cup|weather|stock|today|news|election|score|champion|finals|olympics)\b/i.test(String(q || ''));
}

function promptLooksEmptyDocs(prompt) {
  const s = String(prompt || '');
  return /Documents:\s*(\[]|none|)\s*$/im.test(s) || /Context:\s*(\[]|none|)\s*$/im.test(s) || /Documents:\s*\[\]/i.test(s);
}

export function retrieveDemoDocs(question) {
  const q = String(question || '').toLowerCase();
  const words = q.split(/[^a-z0-9]+/).filter(w => w.length > 2);
  if (!words.length) return [];
  const scored = DEMO_CORPUS.map(row => {
    const hay = (row.text + ' ' + (row.tags || []).join(' ')).toLowerCase();
    const hits = words.filter(w => hay.indexOf(w) >= 0).length;
    return { text: row.text, hits };
  }).filter(r => r.hits > 0);
  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, 3).map(r => r.text);
}

export function mockStructured(schemaFields, input, extra) {
  const q = String(input || 'the question').slice(0, 80);
  const prompt = extra && extra.prompt;
  const obj = {};
  (schemaFields || []).forEach(f => {
    const key = f.key;
    const type = String(f.type || 'str');
    if (key === 'search_queries' || type === 'list' || type === 'list[str]') {
      obj[key] = ['What is missing from: ' + q, 'Evidence for: ' + q];
    } else if (key === 'references') {
      obj[key] = ['https://example.com/mock-source'];
    } else if (key === 'answer') {
      obj[key] = 'Mock answer (not a live model) for: ' + q;
    } else if (key === 'generation') {
      obj[key] = 'Mock generation (not a live model) for: ' + q;
    } else if (key === 'datasource') {
      obj[key] = looksOffCorpus(q) ? 'websearch' : 'vectorstore';
    } else if (key === 'binary_score') {
      obj[key] = promptLooksEmptyDocs(prompt) ? 'no' : 'yes';
    } else if (type.indexOf('schema:') === 0) {
      obj[key] = { missing: 'mock: missing evidence', superfluous: 'mock: extra claims' };
    } else if (type === 'int') {
      obj[key] = 1;
    } else if (type === 'float') {
      obj[key] = 1.0;
    } else if (type === 'bool') {
      obj[key] = false;
    } else {
      obj[key] = 'mock ' + key;
    }
  });
  return obj;
}

function snapshot(state, keys) {
  const out = {};
  (keys || Object.keys(state)).forEach(k => {
    try {
      out[k] = JSON.parse(JSON.stringify(state[k]));
    } catch (_) {
      out[k] = String(state[k]);
    }
  });
  return out;
}

function countToolMessages(messages) {
  return (messages || []).filter(m => m && (m.role === 'tool' || m.kind === 'tool')).length;
}

function stopRoundsN(graph, n, state) {
  const d = (n && n.detail) || {};
  if (d.stopMaxMode === 'literal') {
    const lit = asInt(d.stopMax, null);
    if (lit != null) return lit;
  }
  if (d.stopMaxMode === 'const') {
    const nConst = asInt(constValueByKey(graph.consts, d.stopMax), null);
    if (nConst != null) return nConst;
  }
  const key = d.stopMax || 'max_iterations';
  if (state[key] != null) return asInt(state[key], 2);
  const row = (graph.stateVars || []).find(v => v.key === key);
  if (row) return asInt(row.val, 2);
  return 2;
}

function pickRouterEdge(graph, n, shouldStop, outs) {
  const stopRe = /^(si|yes|end|enough|stop|true|ok)$/i;
  const contRe = /^(no|continue|retry|loop|false|generate)$/i;
  if (shouldStop) {
    return outs.find(e => stopRe.test(e.label || ''))
      || outs.find(e => {
        const t = nodeById(graph, e.to);
        return t && t.type === 'end';
      })
      || outs[0];
  }
  return outs.find(e => contRe.test(e.label || ''))
    || outs.find(e => {
      const t = nodeById(graph, e.to);
      return t && t.type !== 'end';
    })
    || outs[1]
    || outs[0];
}

function asQueryList(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean).slice(0, 3);
  if (raw != null && String(raw).trim()) return [String(raw).trim()];
  return [];
}

function queriesFromState(state, fromKey) {
  const key = fromKey || 'search_queries';
  if (key === 'question' || key === 'user_input' || key === 'query') {
    const direct = asQueryList(state[key]);
    if (direct.length) return direct;
  }
  const msgs = state.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || (m.role !== 'assistant' && m.kind !== 'llm')) continue;
    const args = m.args || {};
    const fromMsg = asQueryList(args[key] != null ? args[key] : args.search_queries);
    if (fromMsg.length) return fromMsg;
    break;
  }
  const fromState = asQueryList(state[key]);
  if (fromState.length) return fromState;
  return [];
}

function responseField(args, name) {
  if (!args || typeof args !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(args, name)) return args[name];
  return undefined;
}

export function evalWriteExpr(expr, ctx) {
  const e = String(expr || '').trim();
  if (!e) return { ok: false };
  if ((e.charAt(0) === '"' && e.charAt(e.length - 1) === '"')
    || (e.charAt(0) === "'" && e.charAt(e.length - 1) === "'")) {
    return { ok: true, value: e.slice(1, -1) };
  }
  const state = (ctx && ctx.state) || {};
  const args = (ctx && ctx.args) || {};
  const toolText = (ctx && ctx.toolText) || '';
  const toolResults = (ctx && ctx.toolResults) || [];

  if (/^retriever\.invoke\s*\(/i.test(e)) {
    const q = state.question || state.user_input || '';
    return { ok: true, value: retrieveDemoDocs(q) };
  }

  if (/^relevant_docs$/i.test(e)) {
    const score = String(responseField(args, 'binary_score') == null ? '' : responseField(args, 'binary_score')).trim().toLowerCase();
    const keep = score === 'yes' || score === 'true' || score === '1';
    const docs = Array.isArray(state.documents) ? state.documents.slice() : [];
    return { ok: true, value: keep ? docs : [] };
  }

  if (/document\s*\(/i.test(e) && /web_results/i.test(e)) {
    const snippets = toolResults.map(r => r && r.snippet).filter(Boolean);
    const text = toolText || snippets.join('\n\n');
    return { ok: true, value: text ? [text] : [] };
  }

  const cmp = e.match(/^response\.([a-zA-Z_][a-zA-Z0-9_]*)\s*(==|!=)\s*["']([^"']*)["']\s*$/);
  if (cmp) {
    const left = String(responseField(args, cmp[1]) == null ? '' : responseField(args, cmp[1])).trim().toLowerCase();
    const right = cmp[3].trim().toLowerCase();
    const eq = left === right;
    return { ok: true, value: cmp[2] === '==' ? eq : !eq };
  }

  const field = e.match(/^response\.([a-zA-Z_][a-zA-Z0-9_]*)$/);
  if (field) {
    const v = responseField(args, field[1]);
    if (v === undefined) return { ok: false };
    return { ok: true, value: v };
  }

  return { ok: false };
}

function isIdentityWriteExpr(expr, key) {
  const e = String(expr || '').trim();
  if (!e) return true;
  const k = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    '^(state\\s*\\[\\s*[\'"]' + k + '[\'"]\\s*\\]|state\\.get\\s*\\(\\s*[\'"]' + k + '[\'"]\\s*\\)|state\\.' + k + ')$'
  ).test(e);
}

function payloadWriteValue(payload, key) {
  const args = (payload && payload.args) || {};
  if (Object.prototype.hasOwnProperty.call(args, key) && !isEmptyValue(args[key])) return args[key];
  const preferred = ['answer', 'generation', 'report', 'informe', 'text', 'content', 'output', 'result'];
  for (let i = 0; i < preferred.length; i++) {
    const v = args[preferred[i]];
    if (v != null && !isEmptyValue(v)) return v;
  }
  const strings = Object.keys(args).map(k => args[k]).filter(v => typeof v === 'string' && String(v).trim());
  if (strings.length === 1) return strings[0];
  const msg = payload && payload.message;
  if (msg && typeof msg.content === 'string' && msg.content.trim()) return msg.content;
  return undefined;
}

function applyWrites(state, writes, payload) {
  const wrote = {};
  const args = (payload && payload.args) || {};
  (writes || []).forEach(w => {
    if (!w || !w.key) return;
    if (w.op === 'append' && w.key === 'messages') {
      if (!Array.isArray(state.messages)) state.messages = [];
      state.messages.push(payload.message);
      wrote.messages = '(appended)';
      return;
    }
    if (w.op === 'increment') {
      state[w.key] = asInt(state[w.key], 0) + 1;
      wrote[w.key] = state[w.key];
      return;
    }
    if (w.expr && !isIdentityWriteExpr(w.expr, w.key)) {
      const ev = evalWriteExpr(w.expr, {
        state,
        args,
        toolText: payload.toolText || '',
        toolResults: payload.toolResults || [],
      });
      if (ev.ok) {
        state[w.key] = ev.value;
        wrote[w.key] = state[w.key];
        return;
      }
    }
    const fromPayload = payloadWriteValue(payload, w.key);
    if (fromPayload !== undefined) {
      state[w.key] = fromPayload;
      wrote[w.key] = fromPayload;
      return;
    }
    if (Object.prototype.hasOwnProperty.call(args, w.key)) {
      state[w.key] = args[w.key];
      wrote[w.key] = state[w.key];
      return;
    }
    if (w.op === 'set' && w.key === 'search_queries' && args.search_queries) {
      state.search_queries = args.search_queries;
      wrote.search_queries = state.search_queries;
    }
  });
  ['search_queries', 'answer', 'documents', 'notes', 'draft', 'generation'].forEach(k => {
    if (args[k] != null && state[k] !== undefined && wrote[k] == null) {
      state[k] = args[k];
      wrote[k] = state[k];
    }
  });
  return wrote;
}

function lastUserText(state) {
  const msgs = state.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'user') return msgs[i].content;
  }
  return state.question || state.user_input || '';
}

function formatPromptValue(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.length && v[0] && (v[0].role || v[0].content)) {
    return v.map(m => {
      const role = (m && (m.role || m.kind)) || 'msg';
      const body = (m && m.content) || (m && m.args ? JSON.stringify(m.args) : '');
      return role + ': ' + body;
    }).join('\n');
  }
  try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
}

export function interpolatePrompt(template, state, extra) {
  const src = String(template || '');
  if (!src.trim()) return '';
  const bag = Object.assign({}, state || {}, extra || {});
  return src.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (all, key) => {
    if (!Object.prototype.hasOwnProperty.call(bag, key)) return all;
    return formatPromptValue(bag[key]);
  });
}

export function mockToolResults(toolId, queries) {
  const name = toolId || 'tool';
  return (queries || ['(empty query)']).map(q => ({
    query: q,
    snippet: 'Mock ' + name + ' result for “' + q + '”. Not a live web search.',
  }));
}

async function runAction(graph, n, state, adapters, counters) {
  const d = n.detail || {};
  const kind = d.kind || 'function';
  const reads = snapshot(state, d.reads && d.reads.length ? d.reads : Object.keys(state));
  let wrote = {};
  let llm = null;
  let tool = null;

  if (kind === 'llm') {
    if (counters.llm >= MAX_LLM) throw new Error('Stopped: too many LLM calls in one run.');
    counters.llm += 1;
    const fields = flattenSchemaFields(graph, d.outputSchemaId);
    const schemaName = (schemaById(graph, d.outputSchemaId) || {}).name || '';
    const input = lastUserText(state);
    const promptTemplate = String(d.prompt || '');
    const prompt = interpolatePrompt(promptTemplate, state, {
      question: input,
      user_input: input,
      input,
    });
    const tempRaw = d.temperature;
    const temperature = tempRaw == null || tempRaw === '' ? null : Number(tempRaw);
    const args = await adapters.llm({
      system: d.system || 'Fill the output schema. Return JSON only.',
      promptTemplate,
      prompt,
      schemaName,
      fields,
      messages: state.messages || [],
      input,
      temperature: Number.isFinite(temperature) ? temperature : undefined,
    });
    llm = { schema: schemaName, args, prompt: prompt || promptTemplate };
    const message = {
      role: 'assistant',
      kind: 'llm',
      node: n.label,
      schema: schemaName,
      content: typeof args.answer === 'string' ? args.answer : JSON.stringify(args),
      args,
    };
    wrote = applyWrites(state, d.writes, { message, args });
    if (!d.writes || !d.writes.some(w => w.key === 'messages')) {
      if (!Array.isArray(state.messages)) state.messages = [];
      state.messages.push(message);
      wrote.messages = '(appended)';
    }
  } else if (kind === 'tool') {
    if (counters.tool >= MAX_TOOL) throw new Error('Stopped: too many tool calls in one run.');
    counters.tool += 1;
    const fromKey = ((d.toolArgs || [])[0] || {}).fromKey || '';
    const queries = queriesFromState(state, fromKey);
    const results = await adapters.tool({
      toolId: d.toolId || 'custom',
      tool: d.tool || '',
      queries,
    });
    tool = { toolId: d.toolId || 'custom', queries, results };
    const text = (results || []).map(r => 'Q: ' + r.query + '\nA: ' + r.snippet).join('\n\n');
    const snippets = (results || []).map(r => r && r.snippet).filter(Boolean);
    const message = {
      role: 'tool',
      kind: 'tool',
      node: n.label,
      content: text,
      queries,
      results,
    };
    wrote = applyWrites(state, d.writes, {
      message,
      args: {
        documents: snippets,
        web_results: snippets.join('\n\n'),
      },
      toolText: snippets.join('\n\n'),
      toolResults: results,
    });
    if (!d.writes || !d.writes.some(w => w.key === 'messages')) {
      if (!Array.isArray(state.messages)) state.messages = [];
      state.messages.push(message);
      wrote.messages = '(appended)';
    }
  } else {
    wrote = applyWrites(state, d.writes, {
      message: { role: 'assistant', kind: 'function', node: n.label, content: n.effect || 'function step' },
      args: {},
    });
  }

  return { reads, wrote, llm, tool };
}

function collectOutputs(graph, state) {
  return (graph.outputs || []).map(o => {
    const s = schemaById(graph, o.schemaId);
    let value = null;
    const msgs = state.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const args = msgs[i] && msgs[i].args;
      if (args && o.field && args[o.field] != null) {
        if (!s || !msgs[i].schema || msgs[i].schema === s.name) {
          value = args[o.field];
          break;
        }
      }
    }
    if (value == null && o.field && state[o.field] != null) value = state[o.field];
    return { key: o.key, schema: s ? s.name : '', field: o.field, value };
  });
}

export async function runGraph(graph, input, adapters) {
  const adaptersSafe = adapters || {};
  const llm = adaptersSafe.llm || (async ({ fields, input: q, prompt }) => mockStructured(fields, q, { prompt }));
  const tool = adaptersSafe.tool || (async ({ toolId, queries }) => mockToolResults(toolId, queries));
  const start = startNode(graph);
  if (!start) return { error: 'No start node.', trace: [], state: {}, outputs: [] };

  const state = initRunState(graph, input);
  const trace = [];
  const counters = { llm: 0, tool: 0 };
  let visits = 0;
  let waveRan = new Set();

  function done(error) {
    return { trace, state, outputs: collectOutputs(graph, state), error: error || '' };
  }

  function routeFrom(n, outs) {
    const d = n.detail || {};
    let shouldStop = false;
    let reason = '';
    if (d.stopMode === 'tool_rounds') {
      const nTools = countToolMessages(state.messages);
      const max = stopRoundsN(graph, n, state);
      shouldStop = nTools >= max;
      reason = nTools + ' tool rounds / max ' + max;
    } else {
      shouldStop = evalPredicate(state, d, graph.consts);
      reason = 'predicate ' + (formatPredicate(d) || d.condition || d.predLeft || '') + ' → ' + shouldStop;
    }
    const edge = pickRouterEdge(graph, n, shouldStop, outs);
    trace.push({
      label: n.label,
      type: 'router',
      note: reason,
      branch: (edge && edge.label) || '',
      reads: snapshot(state, d.reads || ['messages', 'max_iterations']),
    });
    return edge ? edge.to : null;
  }

  async function runActionNode(n) {
    const result = await runAction(graph, n, state, { llm, tool }, counters);
    waveRan.add(n.id);
    trace.push({
      label: n.label,
      type: 'action',
      kind: (n.detail && n.detail.kind) || 'function',
      reads: result.reads,
      wrote: result.wrote,
      llm: result.llm,
      tool: result.tool,
      messages: (state.messages || []).slice(),
    });
  }

  async function walkFrom(id, gather) {
    while (id && visits < MAX_VISITS) {
      visits += 1;
      const n = nodeById(graph, id);
      if (!n) return { type: 'stop' };
      const outs = outgoing(graph, id);

      if (n.type === 'join') return { type: 'join', id };
      if (n.type === 'end') return { type: 'end', id };
      if (n.type === 'start') {
        if (!outs.length) return { type: 'stop' };
        if (outs.length === 1) { id = outs[0].to; continue; }
        return fanOut(outs);
      }
      if (n.type === 'router') {
        id = routeFrom(n, outs);
        continue;
      }

      try {
        if (!(gather && waveRan.has(n.id))) await runActionNode(n);
      } catch (err) {
        trace.push({
          label: n.label,
          type: 'error',
          note: [err.message, err.detail].filter(Boolean).join(' — ').slice(0, 400),
        });
        return { type: 'error', error: err.message || String(err) };
      }

      if (!outs.length) return { type: 'stop' };
      if (outs.length > 1) return fanOut(outs);
      id = outs[0].to;
    }
    return { type: visits >= MAX_VISITS ? 'limit' : 'stop' };
  }

  async function fanOut(outs) {
    const results = [];
    for (let i = 0; i < outs.length; i++) {
      results.push(await walkFrom(outs[i].to));
    }
    const err = results.find(r => r && r.type === 'error');
    if (err) return err;
    const join = results.find(r => r && r.type === 'join');
    if (join) return join;
    const end = results.find(r => r && r.type === 'end');
    if (end) return end;
    return results[results.length - 1] || { type: 'stop' };
  }

  async function resolveJoin(joinId) {
    const n = nodeById(graph, joinId);
    const preds = incoming(graph, joinId).map(e => e.from);
    // Routers into a join are alternate entries (yes/budget), not workers.
    // Only gather unread ACTION predecessors; never re-enter a conditional.
    for (let i = 0; i < preds.length; i++) {
      const pid = preds[i];
      const pred = nodeById(graph, pid);
      if (!pred || pred.type !== 'action') continue;
      if (waveRan.has(pid)) continue;
      const r = await walkFrom(pid, true);
      if (r && r.type === 'error') return r;
    }
    const unread = preds.filter(pid => {
      const pred = nodeById(graph, pid);
      if (!pred || pred.type !== 'action') return false;
      return !waveRan.has(pid);
    });
    if (unread.length) {
      const names = unread.map(pid => (nodeById(graph, pid) || {}).label || pid);
      const note = 'barrier held — still waiting for ' + names.join(', ');
      trace.push({ id: joinId, label: n.label, type: 'join', status: 'held', note, waitKeys: [] });
      return { type: 'error', error: 'Join "' + n.label + '" is waiting for: ' + names.join(', ') + '.' };
    }
    const keys = waitKeysOf(n);
    backfillWaitKeys(graph, preds, keys, state, trace);
    const missing = missingWaitKeys(state, keys);
    const reads = snapshot(state, keys.length ? keys : (n.detail && n.detail.reads) || []);
    if (missing.length) {
      const note = 'barrier held — still waiting for ' + missing.join(', ');
      trace.push({
        id: joinId,
        label: n.label,
        type: 'join',
        status: 'held',
        note,
        waitKeys: keys,
        missing,
        reads,
      });
      return { type: 'error', error: 'Join "' + n.label + '" is waiting for: ' + missing.join(', ') + '.' };
    }
    const ready = keys.length
      ? 'barrier released — every wait key is present: ' + keys.join(', ')
      : 'barrier released — every incoming branch arrived';
    trace.push({
      id: joinId,
      label: n.label,
      type: 'join',
      status: 'released',
      note: ready,
      waitKeys: keys,
      missing: [],
      reads,
    });
    const outs = outgoing(graph, joinId);
    waveRan = new Set();
    return { type: 'continue', id: outs[0] ? outs[0].to : null };
  }

  trace.push({ label: start.label, type: 'start', note: 'graph start' });
  let step = await walkFrom(start.id);

  while (step && step.type === 'join') {
    step = await resolveJoin(step.id);
    if (step.type === 'continue') {
      if (!step.id) break;
      const nxt = nodeById(graph, step.id);
      if (nxt && nxt.type === 'end') {
        step = { type: 'end', id: step.id };
        break;
      }
      if (nxt && nxt.type === 'join') continue;
      step = await walkFrom(step.id);
    }
  }

  if (step && step.type === 'error') return done(step.error);
  if (step && step.type === 'end') {
    const n = nodeById(graph, step.id);
    trace.push({
      label: (n && n.label) || 'end',
      type: 'end',
      note: 'run finished',
      outputs: collectOutputs(graph, state),
    });
    return done('');
  }

  return done(
    visits >= MAX_VISITS || (step && step.type === 'limit')
      ? 'Stopped: visit limit (possible infinite loop).'
      : 'Run stopped without reaching end.',
  );
}

export const defaultMockAdapters = {
  llm: async ({ fields, input, prompt }) => mockStructured(fields, input, { prompt }),
  tool: async ({ toolId, queries }) => mockToolResults(toolId, queries),
};
