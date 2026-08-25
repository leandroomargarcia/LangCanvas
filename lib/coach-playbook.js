// LangCanvas coach spec: UI manual + template curricula + canvas diff.
// The LLM narrates this. It must not invent panels or fields.

export const UI_MANUAL = {
  job: `PANEL "problem to solve" (left sidebar).
Write the work: what comes in, what the user should get, what must improve or decide.
Do not write a recipe of node names here.`,

  schemas: `PANEL SCHEMAS (left, under shared state).
A schema is the contract of ONE LLM shot — not shared state.
+ schema → name, optional extends, fields (key, type, description).
Types: str, int, bool, list, list[str], or another schema (nested object).
extends: the child IS the parent plus new fields. Do not copy parent fields.
Bind a schema to an LLM node in NODE DETAIL → output schema.
Leave bind_tools ON so the model cannot return a free paragraph.`,

  state: `PANEL SHARED STATE.
Memory the next node still needs. Not a copy of every schema field.
Each row: key, type (str / int / bool / list / messages), val.
Agent graphs almost always need messages (the thread).
Project onto state only what a tool must read (list key = batch) and what a conditional counts.
Delete leftover keys (often attempts) that the design does not use.`,

  node_llm: `Select the action → NODE DETAIL (double-click).
Kind: LLM (not function). Output schema: the contract this shot must fill.
Reads: state keys it needs (usually messages).
Writes: messages append; plus set any key a later tool/conditional must read.
System prompt: one role line. Keep bind_tools on.`,

  node_tool: `Select the action → NODE DETAIL.
Kind: tool (not LLM — otherwise it "searches" from memory).
Pick a catalog tool (e.g. Tavily Search). Map each arg to a SHARED STATE key.
If that key is type list, generated code batches.
"Runs when LLM returns": tick every LLM schema that should trigger this tool.
Writes: usually messages append so the next LLM sees snippets.`,

  node_function: `Select the action → NODE DETAIL.
Kind: function when the step is deterministic (split, merge, increment).
Reads/writes: only the keys this role truly needs.`,

  router: `Select the node tagged "conditional" → NODE DETAIL (left/center panel, not a separate EDGE DETAIL).
Visible labels only:
- "stop when" dropdown: "state predicate" OR "N tool rounds".
- If "N tool rounds": row "N" → "state key" or "literal", then pick a SHARED STATE int key. Counts tool results in messages; no extra counter.
- If "state predicate": row "if" is dropdowns (state key, operator >=, "other key"/"literal", value). Never a Python text box. Never len(...).
- "then return": branch labels on this node. Click an arrow only to set its short label (no / si). There is no Condition/Guard on edges.
Do not tell the student to type stopMode, stopMax, condition, predLeft, or EDGE DETAIL — those names are not on the panel.`,

  output: `PANEL OUTPUT (left).
Declare what the graph returns to the user (schema + field).
End does not calculate. Do not export internal fuel (critiques, search queries) unless the user should see them.`,

  canvas: `Toolbar: + action, + conditional, + end. Drag from a handle to connect.
Double-click an action for NODE DETAIL / effect ("what does it change in the state?").
Click an edge only to label a branch (no / si). There is no EDGE DETAIL and no condition field on arrows.
Templates ▾ drops a finished pattern; rebuilding by hand is valid — then fill the same fields.`,
};

export const FIELD_GLOSSARY = `Speak only with visible UI labels. Never prescribe camelCase JSON keys as form fields.
Forbidden as UI names: stopMode, stopMax, stopMaxMode, condition, predLeft, predOp, predRight, outputSchemaId, handlesSchemaIds, bindTools, EDGE DETAIL, Guard.
Conditional panel: "stop when", "N", "if", "then return", "state predicate", "N tool rounds", "state key", "literal", "other key".
LLM panel: kind LLM, "output schema", reads, writes.
Tool panel: kind tool, catalog tool, map arg → state key, "runs when LLM returns".
Edges: click to set the label only.`;

function lab(n) {
  return String((n && n.label) || '').trim();
}

function isPlaceholder(n) {
  return /^new (action|conditional|node)/i.test(lab(n));
}

function actions(g) {
  return (g.nodes || []).filter(n => n.type === 'action');
}

function routers(g) {
  return (g.nodes || []).filter(n => n.type === 'router' || n.kind === 'conditional');
}

function stopKind(n) {
  const when = String((n && n.stopWhen) || '').toLowerCase();
  if (when.indexOf('tool round') >= 0 || n.stopMode === 'tool_rounds') return 'tool_rounds';
  if (when.indexOf('predicate') >= 0 || n.stopMode === 'predicate') return 'predicate';
  return n.stopMode || '';
}

function stopNKey(n) {
  if (n && n.N && typeof n.N === 'object') return String(n.N.key || n.N.value || '').trim();
  return String((n && (n.nKey || n.stopMax)) || '').trim();
}

function predicateLeft(n) {
  if (n && n.if && typeof n.if === 'object') return String(n.if.left || '').trim();
  return String((n && (n.predLeft || n.condition)) || '').trim();
}

function ends(g) {
  return (g.nodes || []).filter(n => n.type === 'end');
}

function realActions(g) {
  return actions(g).filter(n => !isPlaceholder(n));
}

function findNode(g, re, type) {
  return (g.nodes || []).find(n => (!type || n.type === type) && re.test(lab(n)));
}

function hasEdge(g, fromRe, toRe, labelRe) {
  const nodes = g.nodes || [];
  const name = (idOrLabel) => {
    const n = nodes.find(x => x.label === idOrLabel || x.id === idOrLabel);
    return (n && n.label) || idOrLabel;
  };
  return (g.edges || []).some(e => {
    const from = name(e.from);
    const to = name(e.to);
    if (fromRe && !fromRe.test(from)) return false;
    if (toRe && !toRe.test(to)) return false;
    if (labelRe && !labelRe.test(e.label || '')) return false;
    return true;
  });
}

function outsFrom(g, label) {
  return (g.edges || []).filter(e => e.from === label);
}

function schemaBy(g, re) {
  return (g.schemas || []).find(s => re.test(s.name || ''));
}

function schemaFields(s) {
  return ((s && s.fields) || []).filter(f => (f.key || '').trim());
}

function stateKey(g, re) {
  return (g.state || []).find(v => re.test(v.key || ''));
}

function gap(id, ui, why, clicks, extra) {
  return {
    id,
    ui,
    why,
    clicks,
    then: extra && extra.then ? extra.then : 'When that is done, say next.',
    pattern: extra && extra.pattern ? extra.pattern : '',
    mode: extra && extra.mode ? extra.mode : 'custom',
  };
}

export const PATTERNS = {
  simple: {
    keys: ['simple branch', 'simple'],
    name: 'Simple branch',
    job: 'Route based on whether enough context already exists: answer directly or search first.',
    wire: 'start → has data? → (yes) answer directly → end; (no) search first → end',
    roles: [
      { type: 'router', name: 'has data?', match: /has data|enough context/i, why: 'the fork' },
      { type: 'action', name: 'answer directly', match: /answer directly|from context/i, why: 'write answer from context' },
      { type: 'action', name: 'search first', match: /search first|retriev/i, why: 'fetch missing context' },
      { type: 'end', name: 'end', why: 'both paths stop' },
    ],
    state: [
      { key: 'has_data', type: 'str', val: 'false' },
      { key: 'answer', type: 'str', val: '' },
    ],
  },
  retry: {
    keys: ['retry', 'repair'],
    name: 'Retry / repair',
    job: 'Plan a search, run it, retry until results are good enough or attempts are exhausted.',
    wire: 'start → plan → search → evaluate. enough → end. retry → plan',
    roles: [
      { type: 'action', name: 'plan', match: /^plan$/i, why: 'decide what to search' },
      { type: 'action', name: 'search', match: /^search$/i, why: 'attempts += 1; store results' },
      { type: 'router', name: 'evaluate', match: /evaluate|enough/i, why: 'enough vs retry; budget of attempts' },
      { type: 'end', name: 'end', why: 'success or budget spent' },
    ],
    state: [
      { key: 'attempts', type: 'int', val: '0' },
      { key: 'enough', type: 'str', val: 'false' },
      { key: 'results', type: 'str', val: '' },
    ],
    router: { name: /evaluate/i, mode: 'predicate', left: 'attempts' },
  },
  react: {
    keys: ['react agent', 'react'],
    name: 'ReAct',
    job: 'The model reasons, optionally calls tools, and loops until it can answer.',
    wire: 'start → agent → tools_condition. yes → tools → agent. no → end',
    roles: [
      { type: 'action', name: 'agent', match: /^agent$|reason/i, why: 'call the model' },
      { type: 'router', name: 'tools_condition', match: /tools_condition|needs tool/i, why: 'is there a tool call?' },
      { type: 'action', name: 'tools', match: /^tools$|execute tool/i, why: 'execute tool calls' },
      { type: 'end', name: 'end', why: 'stop when there is no tool call' },
    ],
    state: [{ key: 'messages', type: 'messages', val: '[]' }],
    wireNodes: [
      { match: /agent/i, kind: 'llm', reads: ['messages'], writes: ['messages'] },
      { match: /tools$/i, kind: 'tool', reads: ['messages'], writes: ['messages'] },
    ],
  },
  reflection: {
    keys: ['reflection'],
    name: 'Reflection',
    job: 'Generate a draft, critique it, then refine or finish. No web search.',
    wire: 'start → generate → reflect → should_continue. generate → generate. end → end',
    roles: [
      { type: 'action', name: 'generate', match: /generate|draft/i, why: 'call model; produce draft' },
      { type: 'action', name: 'reflect', match: /reflect|critique/i, why: 'critique draft; iterations++' },
      { type: 'router', name: 'should_continue', match: /should_continue|enough|max/i, why: 'OK or max iter?' },
      { type: 'end', name: 'end', why: 'stop' },
    ],
    state: [
      { key: 'messages', type: 'messages', val: '[]' },
      { key: 'iterations', type: 'int', val: '0' },
      { key: 'max_iterations', type: 'int', val: '3' },
    ],
    wireNodes: [
      { match: /generate/i, kind: 'llm', reads: ['messages'], writes: ['messages'] },
      { match: /reflect/i, kind: 'llm', reads: ['messages'], writes: ['messages', 'iterations'] },
    ],
    router: { name: /should_continue|enough/i, mode: 'predicate', left: 'iterations', right: 'max_iterations' },
  },
  reflexion: {
    keys: ['reflexion', 'reflexionar'],
    name: 'Reflexion',
    job: 'Draft an answer, run search tools, revise from evidence, loop until max iterations.',
    wire: 'start → draft → execute_tools → revise → event_loop. no → execute_tools. si → end',
    roles: [
      { type: 'action', name: 'draft', match: /draft|propos|first.?respond/i, why: 'first hypothesis + search queries' },
      { type: 'action', name: 'execute_tools', match: /execute_tools|tavily|investig/i, why: 'run search_queries (Tavily)' },
      { type: 'action', name: 'revise', match: /revise|revisor|refin/i, why: 'rewrite using tool results + citations' },
      { type: 'router', name: 'event_loop', match: /event_loop|tool.?round/i, why: 'stop after N tool rounds' },
      { type: 'end', name: 'end', why: 'cut; does not compute' },
    ],
    schemas: [
      { name: 'Reflection', fields: ['missing', 'superfluous'], nested: false },
      { name: 'AnswerQuestion', fields: ['answer', 'reflection', 'search_queries'], nested: 'Reflection' },
      { name: 'ReviseAnswer', extends: 'AnswerQuestion', fields: ['references'] },
    ],
    state: [
      { key: 'messages', type: 'messages', val: '[]' },
      { key: 'search_queries', type: 'list', val: '[]' },
      { key: 'max_iterations', type: 'int', val: '2' },
    ],
    wireNodes: [
      {
        match: /draft|propos/i,
        kind: 'llm',
        schema: /AnswerQuestion/i,
        reads: ['messages'],
        writes: ['messages', 'search_queries'],
      },
      {
        match: /execute_tools|search|tavily|investig/i,
        kind: 'tool',
        tool: 'Tavily',
        fromKey: 'search_queries',
        handles: ['AnswerQuestion', 'ReviseAnswer'],
        reads: ['search_queries'],
        writes: ['messages'],
      },
      {
        match: /revise|revisor/i,
        kind: 'llm',
        schema: /ReviseAnswer/i,
        reads: ['messages'],
        writes: ['messages'],
      },
    ],
    router: { name: /event_loop/i, mode: 'tool_rounds', maxKey: 'max_iterations' },
    outputs: [
      { key: 'answer', schema: 'ReviseAnswer', field: 'answer' },
      { key: 'references', schema: 'ReviseAnswer', field: 'references' },
    ],
  },
  tool_calling: {
    keys: ['tool-calling', 'tool calling', 'tool_calling'],
    name: 'Tool-calling',
    job: 'The model either calls a tool or returns a final answer; tool results feed back into the model.',
    wire: 'start → LLM → needs tool? no → end. yes → execute tool → LLM',
    roles: [
      { type: 'action', name: 'LLM', why: 'call tool(s) or final answer' },
      { type: 'router', name: 'needs tool?', why: 'did this shot request a tool?' },
      { type: 'action', name: 'execute tool', why: 'run tool; append ToolMessage' },
      { type: 'end', name: 'end', why: 'final answer' },
    ],
    state: [
      { key: 'messages', type: 'messages', val: '[]' },
      { key: 'pending_tool_calls', type: 'list', val: '[]' },
    ],
    wireNodes: [
      { match: /^llm$/i, kind: 'llm', reads: ['messages'], writes: ['messages'] },
      { match: /execute tool|tools/i, kind: 'tool', reads: ['messages'], writes: ['messages'] },
    ],
  },
  plan_execute: {
    keys: ['plan-and-execute', 'plan and execute', 'plan_execute'],
    name: 'Plan-and-execute',
    job: 'Create a multi-step plan, then execute steps one by one until the plan is complete.',
    wire: 'start → create plan → execute step → steps left? no → end. yes → execute step',
    roles: [
      { type: 'action', name: 'create plan', why: 'write ordered steps[]' },
      { type: 'action', name: 'execute step', why: 'run step; advance index' },
      { type: 'router', name: 'steps left?', why: 'plan index vs length' },
      { type: 'end', name: 'end', why: 'plan finished' },
    ],
    state: [
      { key: 'plan', type: 'list', val: '[]' },
      { key: 'step_index', type: 'int', val: '0' },
      { key: 'step_results', type: 'list', val: '[]' },
    ],
  },
  rag: {
    keys: ['rag', 'retriev'],
    name: 'RAG',
    job: 'Retrieve documents; if context is enough, generate an answer, otherwise fall back.',
    wire: 'start → retrieve → context enough? yes → generate answer → end. no → fallback → end',
    roles: [
      { type: 'action', name: 'retrieve', why: 'query vector store / corpus' },
      { type: 'router', name: 'context enough?', why: 'context strong enough?' },
      { type: 'action', name: 'generate answer', why: 'answer from documents' },
      { type: 'action', name: 'fallback', why: 'clarify or not found' },
      { type: 'end', name: 'end', why: 'after generate or fallback' },
    ],
    state: [
      { key: 'question', type: 'str', val: '' },
      { key: 'documents', type: 'list', val: '[]' },
      { key: 'answer', type: 'str', val: '' },
    ],
    wireNodes: [
      { match: /retrieve/i, kind: 'tool', reads: ['question'], writes: ['documents'] },
      { match: /generate/i, kind: 'llm', reads: ['documents', 'question'], writes: ['answer'] },
    ],
    outputs: [{ key: 'answer', field: 'answer' }],
  },
  naive_rag: {
    keys: ['naive rag', 'naive_rag', 'naive'],
    name: 'Naive RAG',
    job: 'Retrieve documents, then generate an answer from that context. No grading, no fallback.',
    wire: 'start → retrieve → generate → end',
    roles: [
      { type: 'action', name: 'retrieve', why: 'query vector store / corpus' },
      { type: 'action', name: 'generate', why: 'answer from documents' },
      { type: 'end', name: 'end', why: 'after generate' },
    ],
    state: [
      { key: 'question', type: 'str', val: '' },
      { key: 'documents', type: 'list', val: '[]' },
      { key: 'generation', type: 'str', val: '' },
    ],
    wireNodes: [
      { match: /retrieve/i, kind: 'function', reads: ['question'], writes: ['documents'] },
      { match: /generate/i, kind: 'llm', schema: /Generation/i, reads: ['documents', 'question'], writes: ['generation'] },
    ],
    outputs: [{ key: 'generation', schema: 'Generation', field: 'generation' }],
  },
  crag: {
    keys: ['crag', 'corrective rag', 'corrective_rag'],
    name: 'CRAG',
    job: 'Retrieve documents, grade relevance, generate if the guard passes, otherwise web-search then generate.',
    wire: 'start → retrieve → grade_documents → docs relevant? yes → generate → end. no → web_search → generate → end',
    roles: [
      { type: 'action', name: 'retrieve', why: 'query vector store / corpus' },
      { type: 'action', name: 'grade_documents', why: 'relevance guard; set docs_relevant' },
      { type: 'router', name: 'docs relevant?', why: 'generate or Tavily fallback?' },
      { type: 'action', name: 'web_search', why: 'Tavily if corpus failed the guard' },
      { type: 'action', name: 'generate', why: 'answer from documents' },
      { type: 'end', name: 'end', why: 'after generate' },
    ],
    state: [
      { key: 'question', type: 'str', val: '' },
      { key: 'documents', type: 'list', val: '[]' },
      { key: 'docs_relevant', type: 'bool', val: 'false' },
      { key: 'generation', type: 'str', val: '' },
    ],
    wireNodes: [
      { match: /^retrieve$/i, kind: 'function', reads: ['question'], writes: ['documents'] },
      { match: /grade/i, kind: 'llm', schema: /GradeDocuments/i, reads: ['question', 'documents'], writes: ['documents', 'docs_relevant'] },
      { match: /web_search|tavily/i, kind: 'tool', tool: 'Tavily', fromKey: 'question', reads: ['question'], writes: ['documents'] },
      { match: /generate/i, kind: 'llm', schema: /Generation/i, reads: ['documents', 'question'], writes: ['generation'] },
    ],
    outputs: [{ key: 'generation', schema: 'Generation', field: 'generation' }],
  },
  self_rag: {
    keys: ['self-rag', 'self rag', 'self_rag'],
    name: 'Self-RAG',
    job: 'Retrieve once, generate, grade the answer. If it is not grounded, retry generate until it passes or the attempt budget is spent.',
    wire: 'start → retrieve → generate → grade_generation → grounded? yes → end. no → budget spent? yes → end. no → generate',
    roles: [
      { type: 'action', name: 'retrieve', why: 'query vector store / corpus (once)' },
      { type: 'action', name: 'generate', why: 'answer from documents; attempts += 1' },
      { type: 'action', name: 'grade_generation', why: 'output guard; set generation_ok' },
      { type: 'router', name: 'grounded?', why: 'answer grounded? else check budget' },
      { type: 'router', name: 'budget spent?', why: 'attempts vs max: retry or stop' },
      { type: 'end', name: 'end', why: 'grounded, or budget spent' },
    ],
    state: [
      { key: 'question', type: 'str', val: '' },
      { key: 'documents', type: 'list', val: '[]' },
      { key: 'generation', type: 'str', val: '' },
      { key: 'generation_ok', type: 'bool', val: 'false' },
      { key: 'attempts', type: 'int', val: '0' },
      { key: 'max_attempts', type: 'int', val: '3' },
    ],
    wireNodes: [
      { match: /^retrieve$/i, kind: 'function', reads: ['question'], writes: ['documents'] },
      { match: /^generate$/i, kind: 'llm', schema: /Generation/i, reads: ['question', 'documents'], writes: ['generation', 'attempts'] },
      { match: /grade_generation|grade/i, kind: 'llm', schema: /GradeGeneration/i, reads: ['documents', 'generation'], writes: ['generation_ok'] },
    ],
    outputs: [{ key: 'generation', schema: 'Generation', field: 'generation' }],
  },
  adaptive_rag: {
    keys: ['adaptive rag', 'adaptive_rag', 'adaptive'],
    name: 'Adaptive RAG',
    job: 'Route the question to corpus or web, grade retrieved docs, generate, then check groundedness and usefulness. Retry or web-search if the answer fails.',
    wire: 'start → route_question → in corpus? yes → retrieve → grade_documents → docs relevant? yes → generate. no → web_search → generate. generate → grade_generation → grounded? no → generate. yes → grade_answer → useful? yes → end. no → web_search',
    roles: [
      { type: 'action', name: 'route_question', why: 'vectorstore or web (RouteQuery)' },
      { type: 'router', name: 'in corpus?', why: 'retrieve or Tavily?' },
      { type: 'action', name: 'retrieve', why: 'query vector store / corpus' },
      { type: 'action', name: 'grade_documents', why: 'relevance guard; set docs_relevant' },
      { type: 'router', name: 'docs relevant?', why: 'generate or Tavily fallback?' },
      { type: 'action', name: 'web_search', why: 'Tavily for off-corpus, weak docs, or not useful' },
      { type: 'action', name: 'generate', why: 'answer from documents; attempts += 1' },
      { type: 'action', name: 'grade_generation', why: 'set grounded' },
      { type: 'router', name: 'grounded?', why: 'retry generate or check useful' },
      { type: 'action', name: 'grade_answer', why: 'set useful' },
      { type: 'router', name: 'useful?', why: 'end or web search' },
      { type: 'end', name: 'end', why: 'useful answer, or budget spent' },
    ],
    state: [
      { key: 'question', type: 'str', val: '' },
      { key: 'documents', type: 'list', val: '[]' },
      { key: 'generation', type: 'str', val: '' },
      { key: 'use_vectorstore', type: 'bool', val: 'true' },
      { key: 'docs_relevant', type: 'bool', val: 'false' },
      { key: 'grounded', type: 'bool', val: 'false' },
      { key: 'useful', type: 'bool', val: 'false' },
      { key: 'attempts', type: 'int', val: '0' },
      { key: 'max_attempts', type: 'int', val: '3' },
    ],
    wireNodes: [
      { match: /route_question/i, kind: 'llm', schema: /RouteQuery/i, reads: ['question'], writes: ['use_vectorstore'] },
      { match: /^retrieve$/i, kind: 'function', reads: ['question'], writes: ['documents'] },
      { match: /grade_documents/i, kind: 'llm', schema: /GradeDocuments/i, reads: ['question', 'documents'], writes: ['documents', 'docs_relevant'] },
      { match: /web_search|tavily/i, kind: 'tool', tool: 'Tavily', fromKey: 'question', reads: ['question'], writes: ['documents'] },
      { match: /^generate$/i, kind: 'llm', schema: /Generation/i, reads: ['question', 'documents'], writes: ['generation', 'attempts'] },
      { match: /grade_generation/i, kind: 'llm', schema: /GradeGeneration/i, reads: ['documents', 'generation'], writes: ['grounded'] },
      { match: /grade_answer/i, kind: 'llm', schema: /GradeAnswer/i, reads: ['question', 'generation'], writes: ['useful'] },
    ],
    outputs: [{ key: 'generation', schema: 'Generation', field: 'generation' }],
  },
  supervisor: {
    keys: ['supervisor', 'worker'],
    name: 'Supervisor + workers',
    job: 'Supervisor routes each turn to a specialist, then continue or finish.',
    wire: 'start → supervisor → writer | researcher | end. workers handoff back to supervisor',
    roles: [
      { type: 'router', name: 'supervisor', why: 'who should act, or done?' },
      { type: 'action', name: 'writer', why: 'draft response from notes' },
      { type: 'action', name: 'researcher', why: 'gather facts; write notes' },
      { type: 'end', name: 'end', why: 'supervisor chooses stop' },
    ],
    state: [
      { key: 'messages', type: 'messages', val: '[]' },
      { key: 'notes', type: 'str', val: '' },
      { key: 'draft', type: 'str', val: '' },
    ],
  },
  map_reduce: {
    keys: ['map-reduce', 'map_reduce', 'map reduce'],
    name: 'Map-reduce',
    job: 'Split work into chunks, process each worker path, merge into one result.',
    wire: 'start → split work → worker A|B|C → merge → end',
    roles: [
      { type: 'action', name: 'split work', why: 'create chunks[]' },
      { type: 'action', name: 'worker A', why: 'process chunk A' },
      { type: 'action', name: 'worker B', why: 'process chunk B' },
      { type: 'action', name: 'worker C', why: 'process chunk C' },
      { type: 'action', name: 'merge', why: 'combine partials' },
      { type: 'end', name: 'end', why: 'after merge' },
    ],
    state: [
      { key: 'chunks', type: 'list', val: '[]' },
      { key: 'partials', type: 'list', val: '[]' },
      { key: 'result', type: 'str', val: '' },
    ],
  },
  hitl: {
    keys: ['human-in-the-loop', 'human in the loop', 'hitl'],
    name: 'Human-in-the-loop',
    job: 'Draft an action, a human approves or rejects, then continue or revise.',
    wire: 'start → draft action → human approve? yes → apply / send → end. no → revise → draft',
    roles: [
      { type: 'action', name: 'draft action', why: 'propose next action / reply' },
      { type: 'router', name: 'human approve?', why: 'human decision, not a model guess' },
      { type: 'action', name: 'apply / send', why: 'execute approved action' },
      { type: 'action', name: 'revise', why: 'update draft from feedback' },
      { type: 'end', name: 'end', why: 'after approve' },
    ],
    state: [
      { key: 'draft', type: 'str', val: '' },
      { key: 'human_feedback', type: 'str', val: '' },
      { key: 'approved', type: 'str', val: 'false' },
    ],
  },
  guardrails: {
    keys: ['guardrail'],
    name: 'Guardrails',
    job: 'Validate user input, run the agent, check the output before returning it.',
    wire: 'start → input safe? yes → agent → output ok? yes → end. no → refuse. output no → rewrite → agent.',
    roles: [
      { type: 'router', name: 'input safe?', why: 'refuse or repair incoming request' },
      { type: 'action', name: 'agent', why: 'generate candidate answer' },
      { type: 'router', name: 'output ok?', why: 'refuse or repair outgoing answer' },
      { type: 'action', name: 'refuse', why: 'block unsafe input' },
      { type: 'action', name: 'rewrite output', why: 'fix policy issues' },
      { type: 'end', name: 'end', why: 'after the output gate passes' },
    ],
    state: [
      { key: 'user_input', type: 'str', val: '' },
      { key: 'input_safe', type: 'bool', val: 'true' },
      { key: 'candidate', type: 'str', val: '' },
      { key: 'output_ok', type: 'bool', val: 'true' },
      { key: 'final_answer', type: 'str', val: '' },
    ],
  },
};

const MATCH_ORDER = [
  'reflexion', 'reflection', 'plan_execute', 'tool_calling', 'map_reduce',
  'supervisor', 'guardrails', 'hitl', 'retry', 'naive_rag', 'crag', 'self_rag', 'adaptive_rag', 'rag', 'react', 'simple',
];

function textHasKey(hay, key) {
  const k = String(key || '').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_-]+');
  return new RegExp('(?:^|[^a-z0-9])' + k + '(?:$|[^a-z0-9])').test(String(hay || '').toLowerCase());
}

export function matchPatternId(text) {
  const s = String(text || '').toLowerCase();
  for (const id of MATCH_ORDER) {
    const p = PATTERNS[id];
    if (p && (p.keys || []).some(k => textHasKey(s, k))) return id;
  }
  return '';
}

export function inferPattern(graph, question, sticky) {
  const g = graph || {};
  const q = matchPatternId(question);
  if (q) return q;
  if (findNode(g, /execute_tools|event_loop/i) || schemaBy(g, /AnswerQuestion|ReviseAnswer/i)) return 'reflexion';
  if (findNode(g, /tools_condition/i)) return 'react';
  const blob = [
    g.problem,
    (g.nodes || []).map(n => n.label).join(' '),
  ].join(' ');
  const fromCanvas = matchPatternId(blob);
  if (fromCanvas) return fromCanvas;
  if (sticky && PATTERNS[sticky]) return sticky;
  return '';
}

function roleRe(r) {
  if (r.match) return r.match;
  return new RegExp(r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_]*'), 'i');
}

function missingRoles(g, spec) {
  return (spec.roles || []).filter(r => {
    const re = roleRe(r);
    if (r.type === 'end') return ends(g).length === 0;
    return !findNode(g, re, r.type === 'router' ? 'router' : r.type === 'action' ? 'action' : undefined);
  });
}

function patternRolesGap(g, spec, id) {
  const missing = missingRoles(g, spec);
  if (!missing.length) return null;
  const have = (spec.roles || []).filter(r => !missing.includes(r)).map(r => r.name);
  const actionBits = spec.roles.filter(r => r.type === 'action').map(r => '**' + r.name + '** (' + r.why + ')').join('; ');
  const otherBits = spec.roles.filter(r => r.type !== 'action').map(r => '**' + r.name + '**' + (r.type === 'router' ? ' (+ conditional)' : '') + ' — ' + r.why).join('; ');
  const missBits = missing.map(r => '**' + r.name + '** (' + r.type + ': ' + r.why + ')').join('; ');
  const clicks = have.length
    ? [
        'You already have: ' + have.join(', ') + '. Still missing: ' + missBits + '.',
        'Wire exactly: ' + spec.wire + ' Skip schemas until the loop reads out loud.',
      ]
    : [
        'Create these actions and rename them (do not leave “new action”): ' + actionBits + '.',
        otherBits ? ('Also add: ' + otherBits + '.') : 'Add + end.',
        'Wire exactly: ' + spec.wire + ' Skip schemas until the loop reads out loud.',
      ];
  return gap('roles', 'canvas', spec.name + ': each box exists because the previous role fails at something.', clicks, { pattern: id, mode: 'pattern' });
}

function patternEffectsGap(g, spec, id) {
  const missingFx = realActions(g).find(n => !(n.effect || '').trim());
  if (!missingFx) return null;
  return gap('effects', 'canvas', 'The label is who. The effect (italic under the name) is what that role changes.', [
    'Double-click **' + lab(missingFx) + '**. Field “what does it change in the state?”: one short sentence.',
    'Repeat for every action before opening SCHEMAS.',
  ], { pattern: id, mode: 'pattern' });
}

function patternConnectGap(g, spec, id) {
  if (!ends(g).length) {
    return gap('end', 'canvas', 'Without an end, the run has nowhere to finish. End does not compute.', [
      '+ end. Wire the stop branch into it. Canonical: ' + spec.wire,
    ], { pattern: id, mode: 'pattern' });
  }
  const dangling = realActions(g).concat(routers(g)).find(n => !(g.edges || []).some(e => e.from === lab(n) || e.to === lab(n)));
  if (dangling) {
    return gap('connect', 'canvas', 'An unconnected role is not part of the system.', [
      'Connect **' + lab(dangling) + '**. Canonical wire: ' + spec.wire,
    ], { pattern: id, mode: 'pattern' });
  }
  return null;
}

function patternSchemaGap(g, spec, id) {
  const need = spec.schemas || [];
  if (!need.length) return null;
  for (const s of need) {
    const hit = schemaBy(g, new RegExp('^' + s.name + '$', 'i')) || schemaBy(g, new RegExp(s.name, 'i'));
    if (!hit || !schemaFields(hit).length) {
      const lines = need.map((sc, i) => {
        const fields = (sc.fields || []).join(', ');
        if (sc.extends) {
          return (i + 1) + ') + schema **' + sc.name + '**, extends **' + sc.extends + '**, add only: ' + fields + '. Do not copy parent fields.';
        }
        if (sc.nested) {
          return (i + 1) + ') + schema **' + sc.name + '** fields: ' + fields + '. The nested field type must be the **' + sc.nested + '** schema (dropdown), not str.';
        }
        return (i + 1) + ') + schema **' + sc.name + '** fields: ' + fields + ' (all str unless listed as list).';
      });
      return gap('schemas', 'schemas', 'The LLM cannot return a paragraph. The next node (tool or output) needs named fields. Freeze that as SCHEMAS.', [
        'Open panel SCHEMAS. Create them in this order (later schemas point at earlier ones):',
        lines.join(' '),
        'Check: three cards if Reflexion; the revision extends the proposal; search_queries / references are lists.',
      ], { pattern: id, mode: 'pattern' });
    }
    if (s.extends) {
      const parent = (hit.extends || '').toLowerCase();
      if (!parent || parent.indexOf(String(s.extends).toLowerCase()) < 0) {
        return gap('schemas', 'schemas', 'extends means the revision IS the proposal plus new fields. Copying fields duplicates the contract.', [
          'On schema **' + s.name + '**, set extends to **' + s.extends + '**.',
          'Keep only the new fields (' + (s.fields || []).join(', ') + '). Delete copied parent fields.',
        ], { pattern: id, mode: 'pattern' });
      }
    }
  }
  return null;
}

function patternStateGap(g, spec, id) {
  const need = spec.state || [];
  if (!need.length) return null;
  const missing = need.filter(s => !stateKey(g, new RegExp('^' + s.key + '$', 'i')));
  if (!missing.length) return null;
  return gap('state', 'state', 'State is memory for the next node, not a copy of schema fields.', [
    'SHARED STATE: set these keys (delete leftovers like unused attempts): '
      + need.map(s => '**' + s.key + '** type ' + s.type + (s.val ? ' val ' + s.val : '')).join('; ') + '.',
    'Do not add schema fields (answer, missing, …) as extra state keys.',
  ], { pattern: id, mode: 'pattern' });
}

function patternWireGap(g, spec, id) {
  const wires = spec.wireNodes || [];
  for (const w of wires) {
    const n = findNode(g, w.match, 'action');
    if (!n) continue;
    const name = lab(n);
    if (w.kind && n.kind !== w.kind) {
      const ui = w.kind === 'llm' ? 'node_llm' : w.kind === 'tool' ? 'node_tool' : 'node_function';
      const clicks = w.kind === 'llm'
        ? [
            'Click **' + name + '**. NODE DETAIL → kind **LLM** (not function).',
            w.schema ? ('Output schema: **' + w.schema.source + '**. Leave bind_tools on.') : 'Pick the output schema this shot must fill, or leave empty only if free text is OK.',
            'Reads: ' + (w.reads || ['messages']).join(', ') + '. Writes: ' + (w.writes || ['messages']).join(' append/set') + '.',
          ]
        : [
            'Click **' + name + '**. Kind **tool** (not LLM).',
            w.tool ? ('Catalog tool: **' + w.tool + '**. Map query → state key **' + (w.fromKey || 'search_queries') + '**.') : 'Pick the catalog tool and map each arg to a state key.',
            w.handles && w.handles.length
              ? ('Tick “runs when LLM returns” for: ' + w.handles.join(' AND ') + '. If you only tick the first, later rounds never run.')
              : 'Tick “runs when LLM returns” for every LLM schema this tool should handle.',
          ];
      return gap('wire_' + name, ui, w.kind === 'tool'
        ? 'If this box were an LLM it would search from memory. The outside world is a tool.'
        : 'The schema is paper until this node is told to fill it.',
      clicks, { pattern: id, mode: 'pattern' });
    }
    if (w.kind === 'llm' && w.schema && !w.schema.test(n.outputSchema || '')) {
      return gap('wire_' + name, 'node_llm', 'This shot must return the named contract or the next node cannot read fields.', [
        'Click **' + name + '**. Output schema must match **' + w.schema.source + '** (not a sibling schema).',
        'Keep bind_tools on. Reads/writes: ' + (w.reads || []).join(', ') + ' / ' + (w.writes || []).join(', ') + '.',
      ], { pattern: id, mode: 'pattern' });
    }
    if (w.kind === 'tool') {
      if (!n.tool) {
        return gap('wire_' + name, 'node_tool', 'A tool node with no catalog tool does nothing.', [
          'Click **' + name + '**. Pick **' + (w.tool || 'the catalog tool') + '**. Map args from state.',
        ], { pattern: id, mode: 'pattern' });
      }
      if (w.handles && w.handles.length) {
        const have = (n.handles || []).join(' ').toLowerCase();
        const miss = w.handles.filter(h => have.indexOf(h.toLowerCase()) < 0);
        if (miss.length) {
          return gap('wire_' + name, 'node_tool', 'The tool must run for every LLM shot that produces its payload.', [
            'Click **' + name + '**. Under “runs when LLM returns”, tick **' + miss.join('** and **') + '**.',
          ], { pattern: id, mode: 'pattern' });
        }
      }
    }
  }
  return null;
}

function patternRouterGap(g, spec, id) {
  const r = spec.router;
  if (!r) {
    const weak = routers(g).find(n => outsFrom(g, lab(n)).length < 2);
    if (weak) {
      return gap('router', 'router', 'A conditional with one exit is not a decision.', [
        'Click **' + lab(weak) + '**. Draw two labeled outgoing arrows (continue vs stop).',
      ], { pattern: id, mode: 'pattern' });
    }
    return null;
  }
  const n = findNode(g, r.name, 'router') || routers(g)[0];
  if (!n) return null;
  const name = lab(n);
  const outs = outsFrom(g, name);
  if (outs.length < 2) {
    return gap('router', 'router', 'Both branches of the stop must go somewhere.', [
      'From **' + name + '**, two arrows matching: ' + spec.wire,
    ], { pattern: id, mode: 'pattern' });
  }
  if (r.mode === 'tool_rounds' && stopKind(n) !== 'tool_rounds') {
    return gap('router', 'router', 'Do not stop on “is the answer good?”. Count tool rounds in messages.', [
      'Click **' + name + '** (tag: conditional) to open NODE DETAIL.',
      'Dropdown **stop when**: choose **N tool rounds** — not state predicate.',
      'Row **N**: **state key**, pick **' + (r.maxKey || 'max_iterations') + '**.',
      'Arrows only get labels: continue (**no**) → the tools node; stop (**si**) → end. Click an edge to edit the label, nothing else.',
    ], { pattern: id, mode: 'pattern' });
  }
  if (r.mode === 'predicate' && stopKind(n) === 'tool_rounds') {
    return gap('router', 'router', 'This pattern stops on a state predicate, not tool rounds.', [
      'Click **' + name + '**. **stop when**: **state predicate**. Row **if**, left dropdown: **' + (r.left || 'iterations') + '**.',
    ], { pattern: id, mode: 'pattern' });
  }
  if (r.mode === 'tool_rounds' && stopKind(n) === 'tool_rounds' && !stopNKey(n)) {
    return gap('router', 'router', 'N tool rounds still needs the budget key.', [
      'On **' + name + '**, row **N**: **state key** → **' + (r.maxKey || 'max_iterations') + '**.',
    ], { pattern: id, mode: 'pattern' });
  }
  return null;
}

function patternOutputGap(g, spec, id) {
  const need = spec.outputs || [];
  if (!need.length) return null;
  if ((g.outputs || []).length) return null;
  return gap('output', 'output', 'End does not calculate. OUTPUT is what you promised the user.', [
    'Panel OUTPUT → + output for: ' + need.map(o => '**' + o.key + '** from ' + (o.schema || 'the last schema') + '.' + (o.field || '')).join('; ') + '.',
    'Do not export critiques or search queries unless the user should see them.',
  ], { pattern: id, mode: 'pattern' });
}

function customGap(g) {
  const problem = (g.problem || '').trim();
  if (!problem) {
    return gap('job', 'job', 'If you cannot say what enters, what the user should get, and what must improve, the diagram is decoration.', [
      'Write that in “problem to solve”. Still no boxes.',
      'If you already know a pattern (ReAct, RAG, Reflexion, supervisor…), say its name and we walk that roster. If this is your own architecture, say so and we fill YOUR fields.',
    ], { mode: 'custom' });
  }
  if (realActions(g).length === 0) {
    return gap('roles', 'canvas', 'Each box is a role from YOUR job — not a copy of Reflexion unless that is the pattern you chose.', [
      'From the job, name 2–4 roles. + action per role and rename it.',
      'If it loops or branches: + conditional with two labeled exits, and + end.',
      'Connect start → first role → … → end. Double-click each action and write a one-line effect.',
    ], { mode: 'custom' });
  }
  const missingFx = realActions(g).find(n => !(n.effect || '').trim());
  if (missingFx) {
    return gap('effects', 'canvas', 'The label is who. The effect (italic under the name) is what that role changes.', [
      'Double-click **' + lab(missingFx) + '**. Field “what does it change in the state?”: one short sentence.',
    ], { mode: 'custom' });
  }
  if (!ends(g).length) {
    return gap('end', 'canvas', 'Without an end, the run has nowhere to finish. End does not compute.', [
      '+ end. Arrow from the last decision or last action into end. Label the branch if it is a conditional exit.',
    ], { mode: 'custom' });
  }
  const dangling = realActions(g).concat(routers(g)).find(n => !(g.edges || []).some(e => e.from === lab(n) || e.to === lab(n)));
  if (dangling) {
    return gap('connect', 'canvas', 'An unconnected role is not part of the system.', [
      'Connect **' + lab(dangling) + '** to the role before or after it.',
    ], { mode: 'custom' });
  }

  const llmBare = realActions(g).find(n => n.kind === 'llm' && !n.outputSchema);
  const toolBare = realActions(g).find(n => n.kind === 'tool' && !n.tool);
  const allFunction = realActions(g).length > 0 && realActions(g).every(n => n.kind === 'function' || !n.kind);

  if (allFunction) {
    const n = realActions(g)[0];
    return gap('kind', 'node_function', 'A box with kind function is a label until you say whether it thinks, talks to the world, or is deterministic.', [
      'Click **' + lab(n) + '**. Set kind: LLM (must return a shape or prose), tool (outside world), or function (deterministic).',
      'Then fill only the fields that kind needs (output schema / catalog tool / reads-writes). Repeat for each role.',
    ], { mode: 'custom' });
  }
  if (llmBare) {
    return gap('wire_llm', 'node_llm', 'An LLM without an output schema returns free text; the next node cannot read a field.', [
      'If this shot must be structured: panel SCHEMAS first, then click **' + lab(llmBare) + '** → output schema.',
      'If free text is OK, say so — then still set reads/writes (usually messages append).',
    ], { mode: 'custom' });
  }
  if (toolBare) {
    return gap('wire_tool', 'node_tool', 'A tool node needs a catalog tool (or a custom name) and args from state.', [
      'Click **' + lab(toolBare) + '**. Pick the tool. Map each arg to a SHARED STATE key.',
      'If an LLM schema should trigger it, tick “runs when LLM returns”.',
    ], { mode: 'custom' });
  }

  const weakR = routers(g).find(n => {
    if (outsFrom(g, lab(n)).length < 2) return true;
    const kind = stopKind(n);
    if (kind === 'tool_rounds') return !stopNKey(n);
    if (kind === 'predicate') return !predicateLeft(n);
    return true;
  });
  if (weakR) {
    return gap('router', 'router', 'Give the conditional a real stop and two labeled exits.', [
      'Click **' + lab(weakR) + '**. **stop when**: state predicate (dropdown **if**) or **N tool rounds** (row **N**) — not “is it good?”, not a Python line.',
      'Two outgoing arrows, labeled so continue vs stop cannot be swapped. Click an edge only to set that label.',
    ], { mode: 'custom' });
  }

  if (!(g.outputs || []).length && realActions(g).some(n => n.kind === 'llm')) {
    return gap('output', 'output', 'Declare what the user should see. End does not compute.', [
      'Panel OUTPUT → + output. Map user-facing fields of the last structured reply (or say the last message is the answer).',
    ], { mode: 'custom' });
  }

  return gap('done', 'output', 'The skeleton matches a complete LangCanvas dictionary: job, roles, contracts, memory, wiring, stop, output.', [
    'Export → Generate code and read it against this canvas. If the code invents a field, the dictionary is still incomplete.',
    'Ask about any node whose NODE DETAIL still looks generic.',
  ], { mode: 'custom', then: 'Ask if you want a review of a specific node.' });
}

export function nextGap(graph, patternId) {
  const g = graph || {};
  const spec = patternId && PATTERNS[patternId];
  if (!spec) return customGap(g);

  const problem = (g.problem || '').trim();
  if (!problem) {
    return gap('job', 'job', spec.name + ': ' + spec.job, [
      'Write the job in “problem to solve” in your words (what enters, what the user gets, what must improve). Not a list of node names.',
      'Cycle in your head: ' + spec.wire,
    ], { pattern: patternId, mode: 'pattern' });
  }

  return patternRolesGap(g, spec, patternId)
    || patternEffectsGap(g, spec, patternId)
    || patternConnectGap(g, spec, patternId)
    || patternSchemaGap(g, spec, patternId)
    || patternStateGap(g, spec, patternId)
    || patternWireGap(g, spec, patternId)
    || patternRouterGap(g, spec, patternId)
    || patternOutputGap(g, spec, patternId)
    || customGap(g);
}

export function buildCoachPack(graph, question, stickyPattern) {
  const pattern = inferPattern(graph, question, stickyPattern);
  const current = nextGap(graph, pattern);
  const uiKey = current.ui || 'canvas';
  const ui = UI_MANUAL[uiKey] || UI_MANUAL.canvas;
  const spec = pattern ? PATTERNS[pattern] : null;
  return {
    mode: current.mode || (pattern ? 'pattern' : 'custom'),
    pattern: pattern || '',
    patternName: spec ? spec.name : 'custom architecture',
    wire: spec ? spec.wire : '',
    gap: current,
    uiKey,
    uiManual: ui,
  };
}

export function formatCoachUserMessage(pack, graphText, question) {
  const g = pack.gap || {};
  const clicks = (g.clicks || []).map((c, i) => (i + 1) + '. ' + c).join('\n');
  const roster = pack.pattern && PATTERNS[pack.pattern]
    ? (PATTERNS[pack.pattern].roles || []).map(r => '- ' + r.name + ' (' + r.type + '): ' + r.why).join('\n')
    : '(custom — derive roles from the student job and CURRENT CANVAS labels; do not invent Reflexion boxes)';
  return [
    'MODE: ' + pack.mode,
    'PATTERN: ' + (pack.patternName || 'custom') + (pack.pattern ? ' [' + pack.pattern + ']' : ''),
    pack.wire ? ('CANONICAL WIRE: ' + pack.wire) : 'CANONICAL WIRE: (none — use the student canvas)',
    '',
    'ROSTER (only if they ask what to create / what to name):',
    roster,
    '',
    'LANGCANVAS UI FOR THIS STEP (panels and fields — this is the product, not LangGraph APIs):',
    pack.uiManual,
    '',
    'FIELD GLOSSARY (visible labels only; JSON keys in CURRENT CANVAS are current values, not form names):',
    FIELD_GLOSSARY,
    '',
    'CURRENT GAP (the next missing canvas fact. Narrate this. Do not skip ahead. Do not copy as a script):',
    'id: ' + (g.id || ''),
    'why: ' + (g.why || ''),
    'clicks:\n' + clicks,
    'then: ' + (g.then || 'When that is done, say next.'),
    '',
    'CURRENT CANVAS (JSON of what is actually on the board):',
    graphText,
    '',
    'QUESTION:',
    question,
  ].join('\n');
}
