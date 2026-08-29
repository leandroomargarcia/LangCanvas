// Pure graph runner. Browser and Node import this.
// adapters.llm / adapters.tool are injected (live API or mock).

import { evalPredicate, formatPredicate } from './predicate.js';

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

function parseStateVal(val, type) {
  const t = String(type || '');
  const s = val == null ? '' : String(val).trim();
  if (t === 'int') return asInt(s, 0);
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
    if (w.expr) {
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
  let id = start.id;
  let visits = 0;

  while (id && visits < MAX_VISITS) {
    visits += 1;
    const n = nodeById(graph, id);
    if (!n) break;
    const outs = outgoing(graph, id);

    if (n.type === 'start') {
      const next = outs[0];
      trace.push({ label: n.label, type: 'start', note: 'graph start' });
      id = next ? next.to : null;
      continue;
    }
    if (n.type === 'end') {
      trace.push({ label: n.label, type: 'end', note: 'run finished', outputs: collectOutputs(graph, state) });
      return { trace, state, outputs: collectOutputs(graph, state), error: '' };
    }
    if (n.type === 'router') {
      const d = n.detail || {};
      let shouldStop = false;
      let reason = '';
      if (d.stopMode === 'tool_rounds') {
        const nTools = countToolMessages(state.messages);
        const max = stopRoundsN(graph, n, state);
        shouldStop = nTools >= max;
        reason = nTools + ' tool rounds / max ' + max;
      } else {
        shouldStop = evalPredicate(state, d);
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
      id = edge ? edge.to : null;
      continue;
    }

    try {
      const result = await runAction(graph, n, state, { llm, tool }, counters);
      const next = outs[0];
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
      id = next ? next.to : null;
    } catch (err) {
      trace.push({
        label: n.label,
        type: 'error',
        note: [err.message, err.detail].filter(Boolean).join(' — ').slice(0, 400),
      });
      return { trace, state, outputs: collectOutputs(graph, state), error: err.message || String(err) };
    }
  }

  return {
    trace,
    state,
    outputs: collectOutputs(graph, state),
    error: visits >= MAX_VISITS ? 'Stopped: visit limit (possible infinite loop).' : 'Run stopped without reaching end.',
  };
}

export const defaultMockAdapters = {
  llm: async ({ fields, input, prompt }) => mockStructured(fields, input, { prompt }),
  tool: async ({ toolId, queries }) => mockToolResults(toolId, queries),
};
