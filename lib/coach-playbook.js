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
+ conditional IS the router. There is no extra router node type.
Visible labels only:
- "stop when" dropdown: "state predicate" OR "N tool rounds".
- If "N tool rounds": row "N" → "state key" or "literal", then pick a SHARED STATE int key. Counts tool results in messages; no extra counter.
- If "state predicate": row "if" is dropdowns. First pick the SHARED STATE key, then the operator. Operators include "is empty", "is not empty", "is truthy", and comparisons. "+ AND another check" adds a second test on the same router. Then pick "match all (AND)" or "match any (OR)". Never a Python text box. Never len(...).
- "then return": branch labels on this node. Click an arrow only to set its short label (no / si). There is no Condition/Guard on edges.
Do not tell the student to type stopMode, stopMax, condition, predLeft, or EDGE DETAIL — those names are not on the panel.`,

  join: `+ join is the barrier / fan-in. It is NOT a conditional and NOT the supervisor.
Wire: worker A → join, worker B → join, join → supervisor (one outgoing arrow).
NODE DETAIL → "wait until present": add each report key (e.g. reporte_habilitaciones and reporte_clasificacion). Button "use incoming writes" fills keys from the workers' writes.
If habilitaciones arrives first, the join HOLDS that report. It does not call the supervisor until clasificacion is also present.
In generated LangGraph this is add_node(..., defer=True).`,

  output: `PANEL OUTPUT (left).
Declare what the graph returns to the user (schema + field).
End does not calculate. Do not export internal fuel (critiques, search queries) unless the user should see them.`,

  canvas: `Toolbar: + action, + conditional, + join, + end. Drag from a handle to connect.
Double-click an action for NODE DETAIL / effect ("what does it change in the state?").
Click an edge only to label a branch (no / si). There is no EDGE DETAIL and no condition field on arrows.
Templates ▾ drops a finished pattern; rebuilding by hand is valid — then fill the same fields.`,
};

export const FIELD_GLOSSARY = `Speak only with visible UI labels. Never prescribe camelCase JSON keys as form fields.
Forbidden as UI names: stopMode, stopMax, stopMaxMode, condition, predLeft, predOp, predRight, outputSchemaId, handlesSchemaIds, bindTools, EDGE DETAIL, Guard.
Conditional panel: "stop when", "N", "if", "then return", "state predicate", "N tool rounds", "state key", "literal", "other key", "is empty", "is not empty", "+ AND another check", "match all (AND)", "match any (OR)".
Join panel: "wait until present", "use incoming writes". + join is the barrier.
LLM panel: kind LLM, "output schema", reads, writes.
Tool panel: kind tool, catalog tool, map arg → state key, "runs when LLM returns".
Edges: click to set the label only.`;

function lab(n) {
  return String((n && n.label) || '').trim();
}

function isPlaceholder(n) {
  return /^new (action|conditional|join|node)/i.test(lab(n));
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

function namedRoster(spec) {
  return (spec.roles || []).filter(r => r.type === 'action' || r.type === 'router');
}

function presentRoleCount(g, spec) {
  return namedRoster(spec).filter(r => {
    const re = roleRe(r);
    if (r.type === 'router') return !!findNode(g, re, 'router');
    return !!findNode(g, re, 'action');
  }).length;
}

function extraNamedRoles(g, spec) {
  const roster = namedRoster(spec);
  return realActions(g).concat(routers(g)).filter(n => {
    const name = lab(n);
    if (!name || isPlaceholder(n)) return false;
    return !roster.some(r => roleRe(r).test(name));
  });
}

export function canvasFitsPattern(g, id) {
  const spec = PATTERNS[id];
  if (!spec) return false;
  const need = namedRoster(spec).length;
  if (!need) return false;
  const have = presentRoleCount(g, spec);
  const min = Math.max(2, Math.ceil(need * 0.6));
  if (have < Math.min(min, need)) return false;
  // Supervisor + workers + a RAG loop is a custom graph, not Self-RAG.
  if (extraNamedRoles(g, spec).length >= 2) return false;
  return true;
}

export function inferPattern(graph, question, sticky) {
  const g = graph || {};
  const named = matchPatternId(question);
  if (named && (!realActions(g).length || canvasFitsPattern(g, named))) return named;

  let best = '';
  let bestCount = 0;
  let second = 0;
  MATCH_ORDER.forEach(id => {
    const spec = PATTERNS[id];
    if (!spec) return;
    const n = presentRoleCount(g, spec);
    if (n > bestCount) {
      second = bestCount;
      bestCount = n;
      best = id;
    } else if (n > second) {
      second = n;
    }
  });
  if (best && canvasFitsPattern(g, best) && bestCount > second) return best;
  if (sticky && PATTERNS[sticky] && canvasFitsPattern(g, sticky)) return sticky;
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

function stamp(row, phase, phaseName) {
  if (!row) return null;
  row.phase = phase;
  row.phaseName = phaseName;
  return row;
}

function duplicateLabels(g) {
  const counts = {};
  (g.nodes || []).forEach(n => {
    const name = lab(n);
    if (!name) return;
    counts[name] = (counts[name] || 0) + 1;
  });
  return Object.keys(counts).filter(k => counts[k] > 1);
}

function looksLlmRole(n) {
  if (n.kind === 'llm') return true;
  return /generat|grade|classif|analis|draft|revis|writer|critic|route_question|supervisor/i.test(lab(n))
    && n.type === 'action';
}

function suggestedStateRows(g) {
  const rows = [];
  const add = (key, type, why) => {
    if (!rows.some(r => r.key === key)) rows.push({ key, type, why });
  };
  add('question', 'str', 'What the user types in Execution. retrieve and LLM nodes read it.');
  if (findNode(g, /retriev/i)) {
    add('documents', 'list', 'Snippets from the corpus. retrieve writes it; classifiers / generate / grade_generation read it.');
  }
  if (findNode(g, /supervisor/i) || findNode(g, /message/i)) {
    add('messages', 'messages', 'The thread workers and the supervisor share. Each specialist appends; supervisor reads it to route.');
  }
  if (findNode(g, /grounded|grade_generation|generation_ok/i)) {
    add('generation_ok', 'bool', 'grade_generation writes true/false; the conditional grounded? reads it.');
  }
  if (findNode(g, /budget|grounded/i)) {
    add('attempts', 'int', 'Incremented each time the generator/classifier retries. budget spent? compares it.');
    add('max_attempts', 'int', 'Retry ceiling. budget spent? reads it on the “if” row.');
  }
  realActions(g).forEach(n => {
    const name = lab(n);
    if (/ncm|clasific/i.test(name)) {
      add('ncm', 'str', name + ' writes the NCM code; OUTPUT and later specialists can read it.');
    }
    if (/habilit/i.test(name)) {
      add('habilitaciones', 'str', name + ' writes the analysis; supervisor / OUTPUT read it.');
    }
    if (/^generate$|generation/i.test(name) && !/grade/.test(name)) {
      add('generation', 'str', name + ' writes the answer; grade_generation reads it.');
    }
  });
  return rows;
}

function suggestedSchemas(g) {
  const out = [];
  realActions(g).filter(looksLlmRole).forEach(n => {
    const name = lab(n);
    if (/grade_generation|grade/i.test(name) && !/answer/.test(name)) {
      out.push({ name: 'GradeGeneration', fields: 'binary_score (str: yes/no)', usedBy: name, why: 'The grounded? conditional needs a yes/no, not a paragraph.' });
    } else if (/ncm|clasific/i.test(name)) {
      out.push({ name: 'NcmClassification', fields: 'codigo (str), fundamento (str)', usedBy: name, why: 'Freeze the NCM decision so later nodes can read codigo from state.' });
    } else if (/habilit/i.test(name)) {
      out.push({ name: 'HabilitacionesAnalysis', fields: 'dictamen (str), riesgos (list[str])', usedBy: name, why: 'The analyst must return a contract, not free text.' });
    } else if (/generate/i.test(name)) {
      out.push({ name: 'Generation', fields: 'generation (str)', usedBy: name, why: 'grade_generation needs a named answer field.' });
    } else {
      out.push({ name: name.replace(/\W+/g, '_') + 'Out', fields: 'result (str)', usedBy: name, why: 'This LLM role needs a named return so the next node can read it.' });
    }
  });
  return out;
}

function diagramGap(g, spec, id) {
  const mode = spec ? 'pattern' : 'custom';
  const extra = { mode, pattern: id || '' };
  const problem = (g.problem || '').trim();
  if (!problem) {
    return stamp(gap('job', 'job', spec
      ? spec.name + ': ' + spec.job
      : 'The graph is decoration until “problem to solve” says what enters, what the user gets, and what must improve or decide.',
    spec
      ? [
          'Write the job in “problem to solve” in your words — not a list of node names.',
          'Keep the boxes you already drew. Do not wipe the canvas to match another template.',
        ]
      : [
          'Write that in “problem to solve”. Still no boxes if the canvas is empty.',
          'If this is your own architecture, say so. Do not copy Reflexion / Self-RAG unless that is the job.',
        ], extra), 1, 'diagram');
  }
  if (spec) {
    const roles = patternRolesGap(g, spec, id);
    if (roles) return stamp(roles, 1, 'diagram');
    const fx = patternEffectsGap(g, spec, id);
    if (fx) return stamp(fx, 1, 'diagram');
    const conn = patternConnectGap(g, spec, id);
    if (conn) return stamp(conn, 1, 'diagram');
  } else {
    if (realActions(g).length === 0) {
      return stamp(gap('roles', 'canvas',
        'Each box is a role from YOUR job in “problem to solve”. Do not replace them with a template roster.',
        [
          'From the job, name the roles. + action per role and rename it (do not leave “new action”).',
          'If it routes or retries: + conditional with two labeled exits, and + end.',
          'Connect start → … → end. Workers that report to a supervisor must arrow back to it. The supervisor needs a done → end exit.',
        ], extra), 1, 'diagram');
    }
    const dups = duplicateLabels(g);
    if (dups.length) {
      return stamp(gap('connect', 'canvas',
        'Two boxes with the same name share an identity. The dictionary cannot tell them apart.',
        ['Rename duplicates: ' + dups.map(d => '**' + d + '**').join(', ') + ' (e.g. retrieve_ncm vs retrieve_hab).'], extra), 1, 'diagram');
    }
    const missingFx = realActions(g).find(n => !(n.effect || '').trim());
    if (missingFx) {
      return stamp(gap('effects', 'canvas',
        'The label is who. The effect is what it changes — still diagramming, not schemas yet.',
        ['Double-click **' + lab(missingFx) + '**. Field “what does it change in the state?”: one short sentence.'], extra), 1, 'diagram');
    }
    if (!ends(g).length) {
      return stamp(gap('end', 'canvas', 'Without an end, the run has nowhere to finish. End does not compute.',
        ['+ end. If you have a supervisor, draw supervisor → end labeled **done**.',
         'Success and budget-spent paths that finish the job should also reach end (or return to the supervisor first).'], extra), 1, 'diagram');
    }
    const dangling = realActions(g).concat(routers(g)).find(n => !(g.edges || []).some(e => e.from === lab(n) || e.to === lab(n)));
    if (dangling) {
      return stamp(gap('connect', 'canvas', 'An unconnected role is not part of the system described in “problem to solve”.',
        ['Connect **' + lab(dangling) + '** to the role before or after it. Do not delete other specialists to make the graph look like a template.'], extra), 1, 'diagram');
    }
    const thinRouter = routers(g).find(n => outsFrom(g, lab(n)).length < 2);
    if (thinRouter) {
      return stamp(gap('connect', 'canvas', 'A conditional with one exit cannot choose. This is still the diagram, not “stop when”.',
        ['From **' + lab(thinRouter) + '**, draw two labeled arrows (continue vs stop, or ncm vs hab vs done).'], extra), 1, 'diagram');
    }
  }
  return null;
}

function dictionaryGap(g, spec, id) {
  const extra = { mode: spec ? 'pattern' : 'custom', pattern: id || '', phase: 2, phaseName: 'dictionary' };
  if (spec) {
    const st = patternStateGap(g, spec, id);
    if (st) {
      st.clicks = (st.clicks || []).concat(['For each key, say which node writes it and which node reads it. That is why the key exists.']);
      return stamp(st, 2, 'dictionary');
    }
    const sc = patternSchemaGap(g, spec, id);
    if (sc) {
      sc.clicks = (sc.clicks || []).concat(['Each schema is the contract of ONE LLM node. Bind it later in NODE DETAIL → output schema.']);
      return stamp(sc, 2, 'dictionary');
    }
    return null;
  }
  const suggested = suggestedStateRows(g);
  const missingKeys = suggested.filter(s => !stateKey(g, new RegExp('^' + s.key + '$', 'i')));
  if (missingKeys.length) {
    return stamp(gap('state', 'state',
      'SHARED STATE is the memory the next node still needs. Add keys from THIS diagram and “problem to solve”, not from another template.',
      missingKeys.slice(0, 5).map(s =>
        'SHARED STATE → + variable **' + s.key + '** (type ' + s.type + '). Why: ' + s.why
      ), extra), 2, 'dictionary');
  }
  const schemaPlan = suggestedSchemas(g);
  const haveNames = (g.schemas || []).map(s => (s.name || '').toLowerCase());
  const missingSch = schemaPlan.filter(s => !haveNames.some(n => n.indexOf(String(s.name).toLowerCase()) >= 0));
  if (schemaPlan.length && filledSchemasCount(g) === 0) {
    return stamp(gap('schemas', 'schemas',
      'A schema is the contract of one LLM shot — not shared state. The next node cannot read a paragraph.',
      schemaPlan.slice(0, 4).map(s =>
        'SCHEMAS → + schema **' + s.name + '** fields: ' + s.fields + '. Used by **' + s.usedBy + '**. Why: ' + s.why
      ), extra), 2, 'dictionary');
  }
  if (missingSch.length && filledSchemasCount(g) < schemaPlan.length) {
    return stamp(gap('schemas', 'schemas',
      'There are still LLM roles without a contract.',
      missingSch.slice(0, 3).map(s =>
        'SCHEMAS → + schema **' + s.name + '** fields: ' + s.fields + '. Bind later on **' + s.usedBy + '**. Why: ' + s.why
      ), extra), 2, 'dictionary');
  }
  return null;
}

function filledSchemasCount(g) {
  return (g.schemas || []).filter(s => schemaFields(s).length > 0).length;
}

function writesOf(n) {
  const w = n.writes;
  if (!Array.isArray(w)) return [];
  return w.map(x => String(x).split(':')[0]).filter(Boolean);
}

function readsOf(n) {
  return Array.isArray(n.reads) ? n.reads : [];
}

function nodeNeedsConfig(n, g) {
  if (n.type === 'router') {
    if (outsFrom(g, lab(n)).length < 2) return false;
    if (stopKind(n) === 'tool_rounds') return !stopNKey(n);
    return !predicateLeft(n);
  }
  if (n.type !== 'action') return false;
  const kind = n.kind || 'function';
  if (kind === 'llm') return !n.outputSchema || !readsOf(n).length;
  if (kind === 'tool') return !n.tool;
  return !readsOf(n).length && !writesOf(n).length;
}

function configureGap(g, spec, id) {
  const extra = { mode: spec ? 'pattern' : 'custom', pattern: id || '' };
  if (spec) {
    const w = patternWireGap(g, spec, id);
    if (w) return stamp(w, 3, 'configure');
    const r = patternRouterGap(g, spec, id);
    if (r) return stamp(r, 3, 'configure');
    const o = patternOutputGap(g, spec, id);
    if (o) return stamp(o, 3, 'configure');
  }
  const unkind = realActions(g).find(n => looksLlmRole(n) && (n.kind === 'function' || !n.kind));
  if (unkind) {
    return stamp(gap('kind', 'node_llm',
      '**' + lab(unkind) + '** is a thinking role. Kind function would skip the model.',
      [
        'Click **' + lab(unkind) + '**. Kind: **LLM**.',
        'Output schema: pick the schema you created for this role.',
        'Reads: the state keys it needs (usually question + documents or messages). Writes: the key this role produces (and attempts += 1 if it retries).',
      ], extra), 3, 'configure');
  }
  const retrieve = realActions(g).find(n => /retriev/i.test(lab(n)) && !writesOf(n).length);
  if (retrieve) {
    return stamp(gap('kind', 'node_function',
      'retrieve is deterministic: it writes documents, it does not “think”.',
      [
        'Click **' + lab(retrieve) + '**. Kind: **function**.',
        'Reads: **question**. Writes: set **documents**. That is how the next LLM sees the corpus.',
      ], extra), 3, 'configure');
  }
  const llmBare = realActions(g).find(n => n.kind === 'llm' && !n.outputSchema);
  if (llmBare) {
    return stamp(gap('wire_llm', 'node_llm',
      'Without output schema, **' + lab(llmBare) + '** returns a paragraph the next node cannot field-select.',
      [
        'Click **' + lab(llmBare) + '** → output schema (the contract from phase 2).',
        'Reads / writes: only the SHARED STATE keys this role truly uses. Say why each one.',
      ], extra), 3, 'configure');
  }
  const toolBare = realActions(g).find(n => n.kind === 'tool' && !n.tool);
  if (toolBare) {
    return stamp(gap('wire_tool', 'node_tool',
      'A tool node must pick a catalog tool and map args from state.',
      ['Click **' + lab(toolBare) + '**. Pick the tool. Map each arg to a SHARED STATE key. Why: the tool cannot guess the query.'], extra), 3, 'configure');
  }
  const weakR = routers(g).find(n => nodeNeedsConfig(n, g));
  if (weakR) {
    const name = lab(weakR);
    const predHint = /grounded/i.test(name)
      ? '**if** generation_ok equals true (yes → done / supervisor, no → budget spent?).'
      : /budget/i.test(name)
        ? '**if** attempts >= max_attempts (yes → supervisor or end, no → retry the generator).'
        : /supervisor/i.test(name)
          ? 'Route on a state key such as next_worker, or keep labeled exits ncm / hab / done. done → end.'
          : '**stop when**: state predicate. Row **if**: the key this fork actually reads.';
    return stamp(gap('router', 'router',
      '**' + name + '** still has no countable stop. “Is it good?” is not a setting.',
      [
        'Click **' + name + '**. ' + predHint,
        'Outgoing arrows only get labels. Click an edge to set the label.',
      ], extra), 3, 'configure');
  }
  const unread = realActions(g).find(n => nodeNeedsConfig(n, g));
  if (unread) {
    return stamp(gap('kind', 'node_function',
      '**' + lab(unread) + '** still has empty reads/writes, so Execution cannot move data.',
      [
        'Click **' + lab(unread) + '**. Fill reads (what it needs) and writes (what it changes).',
        'Name the SHARED STATE keys from phase 2. That is why those keys exist.',
      ], extra), 3, 'configure');
  }
  if (!(g.outputs || []).length && realActions(g).some(n => n.kind === 'llm' || looksLlmRole(n))) {
    return stamp(gap('output', 'output', 'OUTPUT is what the user should see. End does not compute.',
      ['Panel OUTPUT → + output. Map the user-facing field (ncm, dictamen, generation…).'], extra), 3, 'configure');
  }
  return null;
}

function reviewGap(g) {
  const extra = { mode: 'custom' };
  const issues = [];
  duplicateLabels(g).forEach(d => issues.push('Two nodes named **' + d + '**. Rename one.'));
  if (!ends(g).length) issues.push('Missing **end**.');
  const dangling = realActions(g).concat(routers(g)).filter(n => !(g.edges || []).some(e => e.from === lab(n) || e.to === lab(n)));
  dangling.forEach(n => issues.push('**' + lab(n) + '** is not connected.'));
  realActions(g).filter(n => n.kind === 'llm' && !n.outputSchema).forEach(n => {
    issues.push('**' + lab(n) + '** is LLM without output schema.');
  });
  routers(g).filter(n => nodeNeedsConfig(n, g)).forEach(n => {
    issues.push('**' + lab(n) + '** has no stop predicate / N.');
  });
  const supervisor = routers(g).find(n => /supervisor/i.test(lab(n)));
  if (supervisor && !outsFrom(g, lab(supervisor)).some(e => /done|end/i.test(e.label || e.to || ''))) {
    issues.push('supervisor has no **done** exit to end.');
  }
  if (!issues.length) return null;
  return stamp(gap('review', 'canvas',
    'The diagram and dictionary exist. Now debug against “problem to solve” — do not rebuild it as a stock template.',
    issues.slice(0, 5).map((t, i) => (i + 1) + '. ' + t), extra), 4, 'review');
}

function runGap() {
  return stamp(gap('run', 'canvas',
    'The canvas is ready to try. Execution is the left panel named **execution**, not a new node.',
    [
      'Open panel **execution**. Paste a real input for this job in the textarea (a question / expediente).',
      'Click **Dry run** first: it walks the graph without spending quota so you can see the path.',
      'If the path matches the design, click **Run**. Watch **history**: state in, node out, LLM / tool results.',
      'If a branch is wrong, we go back to NODE DETAIL on that conditional — not to a different template.',
    ], { mode: 'custom', then: 'If the run fails, paste the history and we debug that node.' }), 5, 'run');
}

export function nextGap(graph, patternId) {
  const g = graph || {};
  const spec = patternId && PATTERNS[patternId];
  const id = spec ? patternId : '';
  return diagramGap(g, spec, id)
    || dictionaryGap(g, spec, id)
    || configureGap(g, spec, id)
    || reviewGap(g)
    || runGap();
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
    phase: current.phase || 1,
    phaseName: current.phaseName || 'diagram',
    goal: (graph && graph.problem) || '',
    gap: current,
    uiKey,
    uiManual: ui,
  };
}

export function formatCoachUserMessage(pack, graphText, question, executionText) {
  const g = pack.gap || {};
  const clicks = (g.clicks || []).map((c, i) => (i + 1) + '. ' + c).join('\n');
  const roster = pack.pattern && PATTERNS[pack.pattern]
    ? (PATTERNS[pack.pattern].roles || []).map(r => '- ' + r.name + ' (' + r.type + '): ' + r.why).join('\n')
    : '(custom — roles are the labels on CURRENT CANVAS plus GOAL. Do not invent a template roster. Do not tell them to delete specialists.)';
  return [
    'GOAL (problem to solve — this is the spec of the product they want):',
    pack.goal || '(empty — ask them to write the job in “problem to solve” before inventing nodes)',
    '',
    'MODE: ' + pack.mode + ' | PATTERN: ' + (pack.patternName || 'custom') + (pack.pattern ? ' [' + pack.pattern + ']' : ''),
    pack.wire ? ('TEMPLATE WIRE (only if they asked for this template): ' + pack.wire) : 'TEMPLATE WIRE: none — design THEIR architecture from GOAL.',
    '',
    'Help them in this order, but skip to whatever QUESTION and EXECUTION HISTORY need:',
    '- Architecture: nodes, arrows, join vs conditional vs loop, toward GOAL.',
    '- Shared state: each key — what it stores, who writes it, who reads it.',
    '- Schemas: contract of each LLM shot (not the same as shared state).',
    '- Execution: if a trace is present, debug that run (wrong branch, empty write, join held, missing tool result).',
    '',
    'ROSTER (only if the canvas is empty and they ask what to create):',
    roster,
    '',
    'LANGCANVAS UI (how to click, not what to build):',
    pack.uiManual,
    '',
    'FIELD GLOSSARY:',
    FIELD_GLOSSARY,
    '',
    'CHECKER HINTS (optional lint — do not override GOAL, QUESTION, or EXECUTION HISTORY):',
    'why: ' + (g.why || ''),
    'clicks:\n' + clicks,
    '',
    'CURRENT CANVAS (state, schemas, nodes with prompts/writes, edges):',
    graphText,
    '',
    'EXECUTION HISTORY (last Dry run / Run; empty if they have not run yet):',
    executionText || '(none)',
    '',
    'QUESTION:',
    question,
  ].join('\n');
}
