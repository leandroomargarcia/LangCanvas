import assert from 'node:assert/strict';
import { runGraph, flattenSchemaFields, interpolatePrompt, defaultMockAdapters, evalWriteExpr, retrieveDemoDocs, evalPredicate, formatPredicate, initRunState } from '../lib/run-graph.js';

function reflexionGraph() {
  return {
    version: 2,
    stateVars: [
      { key: 'messages', val: '[]', type: 'messages' },
      { key: 'search_queries', val: '[]', type: 'list' },
      { key: 'max_iterations', val: '2', type: 'int' },
    ],
    schemas: [
      {
        id: 'sch-ref',
        name: 'Reflection',
        fields: [
          { key: 'missing', type: 'str' },
          { key: 'superfluous', type: 'str' },
        ],
      },
      {
        id: 'sch-ans',
        name: 'AnswerQuestion',
        fields: [
          { key: 'answer', type: 'str' },
          { key: 'reflection', type: 'schema:sch-ref' },
          { key: 'search_queries', type: 'list[str]' },
        ],
      },
      {
        id: 'sch-rev',
        name: 'ReviseAnswer',
        extendsId: 'sch-ans',
        fields: [{ key: 'references', type: 'list[str]' }],
      },
    ],
    outputs: [
      { key: 'answer', schemaId: 'sch-rev', field: 'answer' },
      { key: 'references', schemaId: 'sch-rev', field: 'references' },
    ],
    nodes: [
      { id: 'start', type: 'start', label: 'start' },
      {
        id: 'draft',
        type: 'action',
        label: 'draft',
        detail: {
          kind: 'llm',
          reads: ['messages'],
          writes: [
            { key: 'messages', op: 'append' },
            { key: 'search_queries', op: 'set' },
          ],
          outputSchemaId: 'sch-ans',
        },
      },
      {
        id: 'tools',
        type: 'action',
        label: 'execute_tools',
        detail: {
          kind: 'tool',
          toolId: 'tavily',
          toolArgs: [{ param: 'query', fromKey: 'search_queries' }],
          writes: [{ key: 'messages', op: 'append' }],
        },
      },
      {
        id: 'revise',
        type: 'action',
        label: 'revise',
        detail: {
          kind: 'llm',
          reads: ['messages'],
          writes: [{ key: 'messages', op: 'append' }],
          outputSchemaId: 'sch-rev',
        },
      },
      {
        id: 'loop',
        type: 'router',
        label: 'event_loop',
        detail: {
          stopMode: 'tool_rounds',
          stopMaxMode: 'key',
          stopMax: 'max_iterations',
          reads: ['messages', 'max_iterations'],
        },
      },
      { id: 'end', type: 'end', label: 'end' },
    ],
    edges: [
      { from: 'start', to: 'draft' },
      { from: 'draft', to: 'tools' },
      { from: 'tools', to: 'revise' },
      { from: 'revise', to: 'loop' },
      { from: 'loop', to: 'tools', label: 'no' },
      { from: 'loop', to: 'end', label: 'si' },
    ],
  };
}

function reflectionGraph() {
  return {
    stateVars: [
      { key: 'messages', val: '[]', type: 'messages' },
      { key: 'iterations', val: '0', type: 'int' },
      { key: 'max_iterations', val: '2', type: 'int' },
    ],
    schemas: [],
    outputs: [{ key: 'answer', field: 'answer' }],
    nodes: [
      { id: 'start', type: 'start', label: 'start' },
      {
        id: 'gen',
        type: 'action',
        label: 'generate',
        detail: { kind: 'llm', writes: [{ key: 'messages', op: 'append' }] },
      },
      {
        id: 'ref',
        type: 'action',
        label: 'reflect',
        detail: {
          kind: 'llm',
          writes: [
            { key: 'messages', op: 'append' },
            { key: 'iterations', op: 'increment' },
          ],
        },
      },
      {
        id: 'cond',
        type: 'router',
        label: 'should_continue',
        detail: {
          stopMode: 'predicate',
          predLeft: 'iterations',
          predOp: '>=',
          predRightMode: 'key',
          predRight: 'max_iterations',
        },
      },
      { id: 'end', type: 'end', label: 'end' },
    ],
    edges: [
      { from: 'start', to: 'gen' },
      { from: 'gen', to: 'ref' },
      { from: 'ref', to: 'cond' },
      { from: 'cond', to: 'gen', label: 'generate' },
      { from: 'cond', to: 'end', label: 'end' },
    ],
  };
}

const revFields = flattenSchemaFields(reflexionGraph(), 'sch-rev');
assert.deepEqual(
  revFields.map(f => f.key).sort(),
  ['answer', 'references', 'reflection', 'search_queries'],
);

const rx = await runGraph(reflexionGraph(), 'What is LangGraph?', defaultMockAdapters);
assert.equal(rx.error || '', '');
const rxPath = rx.trace.map(s => s.label + (s.branch ? ':' + s.branch : ''));
assert.deepEqual(rxPath, [
  'start',
  'draft',
  'execute_tools',
  'revise',
  'event_loop:no',
  'execute_tools',
  'revise',
  'event_loop:si',
  'end',
]);
assert.equal(rx.trace.filter(s => s.kind === 'llm').length, 3);
assert.equal(rx.trace.filter(s => s.kind === 'tool').length, 2);
const toolStep = rx.trace.find(s => s.kind === 'tool');
assert.ok(toolStep.tool.queries.length > 0, 'tool should receive search_queries');
const answerOut = rx.outputs.find(o => o.key === 'answer');
assert.ok(answerOut && String(answerOut.value || '').includes('Mock answer'), 'OUTPUT.answer from ReviseAnswer');
assert.ok(Array.isArray(rx.outputs.find(o => o.key === 'references').value));

const rf = await runGraph(reflectionGraph(), 'Improve this draft', defaultMockAdapters);
assert.equal(rf.error || '', '');
const rfPath = rf.trace.map(s => s.label + (s.branch ? ':' + s.branch : ''));
assert.deepEqual(rfPath, [
  'start',
  'generate',
  'reflect',
  'should_continue:generate',
  'generate',
  'reflect',
  'should_continue:end',
  'end',
]);

const empty = await runGraph({ nodes: [], edges: [] }, 'hi');
assert.match(empty.error || '', /No start node/);

assert.equal(
  interpolatePrompt('Q: {question}\n{messages}', {
    messages: [{ role: 'user', content: 'hello' }],
  }, { question: 'What is LangGraph?' }),
  'Q: What is LangGraph?\nuser: hello',
);
assert.equal(interpolatePrompt('{missing}', { answer: 'x' }), '{missing}');
assert.equal(
  interpolatePrompt('Retry up to {MAX_ATTEMPTS}', { attempts: 1 }, {
    consts: [{ key: 'MAX_ATTEMPTS', type: 'int', val: '3' }],
  }),
  'Retry up to 3',
);
assert.equal(
  interpolatePrompt('{MAX_ATTEMPTS}', { MAX_ATTEMPTS: 9 }, {
    consts: [{ key: 'MAX_ATTEMPTS', type: 'int', val: '3' }],
  }),
  '9',
  'state wins over constants on name collision',
);

let seenPrompt = '';
const promptGraph = {
  nodes: [
    { id: 'start', type: 'start', label: 'start' },
    {
      id: 'ask',
      type: 'action',
      label: 'ask',
      detail: {
        kind: 'llm',
        prompt: 'Answer {question} using {messages}',
        writes: [{ key: 'messages', op: 'append' }],
      },
    },
    { id: 'end', type: 'end', label: 'end' },
  ],
  edges: [{ from: 'start', to: 'ask' }, { from: 'ask', to: 'end' }],
  stateVars: [{ key: 'messages', val: '[]', type: 'messages' }],
};
const prompted = await runGraph(promptGraph, 'LangGraph?', {
  llm: async (req) => {
    seenPrompt = req.prompt;
    return { answer: 'ok' };
  },
  tool: defaultMockAdapters.tool,
});
assert.equal(prompted.error || '', '');
assert.match(seenPrompt, /Answer LangGraph\?/);
assert.match(seenPrompt, /user: LangGraph\?/);
assert.match(prompted.trace.find(s => s.label === 'ask').llm.prompt, /Answer LangGraph\?/);

assert.deepEqual(
  evalWriteExpr('response.datasource == "vectorstore"', { args: { datasource: 'vectorstore' } }).value,
  true,
);
assert.deepEqual(
  evalWriteExpr('response.datasource == "vectorstore"', { args: { datasource: 'websearch' } }).value,
  false,
);
assert.deepEqual(
  evalWriteExpr('response.binary_score == "yes"', { args: { binary_score: 'yes' } }).value,
  true,
);
assert.equal(
  evalWriteExpr('response.generation', { args: { generation: 'hello' } }).value,
  'hello',
);
assert.equal(
  evalWriteExpr('MAX_ATTEMPTS', {
    state: { attempts: 1 },
    consts: [{ key: 'MAX_ATTEMPTS', type: 'int', val: '3' }],
  }).value,
  3,
);
assert.ok(retrieveDemoDocs('What is agent memory?').length > 0);
assert.equal(retrieveDemoDocs('Who won Wimbledon 2024?').length, 0);

function adaptiveRagGraph() {
  return {
    stateVars: [
      { key: 'question', val: '', type: 'str' },
      { key: 'documents', val: '[]', type: 'list' },
      { key: 'generation', val: '', type: 'str' },
      { key: 'use_vectorstore', val: 'true', type: 'bool' },
      { key: 'docs_relevant', val: 'false', type: 'bool' },
      { key: 'grounded', val: 'false', type: 'bool' },
      { key: 'useful', val: 'false', type: 'bool' },
      { key: 'attempts', val: '0', type: 'int' },
    ],
    consts: [
      { key: 'MAX_ATTEMPTS', val: '3', type: 'int' },
    ],
    schemas: [
      { id: 'sch-route', name: 'RouteQuery', fields: [{ key: 'datasource', type: 'str' }] },
      { id: 'sch-docs', name: 'GradeDocuments', fields: [{ key: 'binary_score', type: 'str' }] },
      { id: 'sch-ground', name: 'GradeGeneration', fields: [{ key: 'binary_score', type: 'str' }] },
      { id: 'sch-ans', name: 'GradeAnswer', fields: [{ key: 'binary_score', type: 'str' }] },
      { id: 'sch-gen', name: 'Generation', fields: [{ key: 'generation', type: 'str' }] },
    ],
    outputs: [{ key: 'generation', schemaId: 'sch-gen', field: 'generation' }],
    nodes: [
      { id: 'start', type: 'start', label: 'start' },
      {
        id: 'route',
        type: 'action',
        label: 'route_question',
        detail: {
          kind: 'llm',
          reads: ['question'],
          writes: [{ key: 'use_vectorstore', op: 'set', expr: 'response.datasource == "vectorstore"' }],
          outputSchemaId: 'sch-route',
          prompt: '{question}',
        },
      },
      {
        id: 'in_corpus',
        type: 'router',
        label: 'in corpus?',
        detail: { stopMode: 'predicate', predLeft: 'use_vectorstore', predOp: 'truthy', reads: ['use_vectorstore'] },
      },
      {
        id: 'retrieve',
        type: 'action',
        label: 'retrieve',
        detail: {
          kind: 'function',
          reads: ['question'],
          writes: [{ key: 'documents', op: 'set', expr: 'retriever.invoke(question)' }],
        },
      },
      {
        id: 'grade_docs',
        type: 'action',
        label: 'grade_documents',
        detail: {
          kind: 'llm',
          reads: ['question', 'documents'],
          writes: [
            { key: 'documents', op: 'set', expr: 'relevant_docs' },
            { key: 'docs_relevant', op: 'set', expr: 'response.binary_score == "yes"' },
          ],
          outputSchemaId: 'sch-docs',
          prompt: 'Question: {question}\n\nDocuments: {documents}',
        },
      },
      {
        id: 'docs_ok',
        type: 'router',
        label: 'docs relevant?',
        detail: { stopMode: 'predicate', predLeft: 'docs_relevant', predOp: 'truthy', reads: ['docs_relevant'] },
      },
      {
        id: 'web',
        type: 'action',
        label: 'web_search',
        detail: {
          kind: 'tool',
          toolId: 'tavily',
          toolArgs: [{ param: 'query', fromKey: 'question' }],
          writes: [{ key: 'documents', op: 'set', expr: '[Document(page_content=web_results)]' }],
          reads: ['question'],
        },
      },
      {
        id: 'gen',
        type: 'action',
        label: 'generate',
        detail: {
          kind: 'llm',
          reads: ['question', 'documents'],
          writes: [
            { key: 'generation', op: 'set', expr: 'response.generation' },
            { key: 'attempts', op: 'increment' },
          ],
          outputSchemaId: 'sch-gen',
          prompt: 'Question: {question}\n\nContext: {documents}',
        },
      },
      {
        id: 'grade_gen',
        type: 'action',
        label: 'grade_generation',
        detail: {
          kind: 'llm',
          reads: ['documents', 'generation'],
          writes: [{ key: 'grounded', op: 'set', expr: 'response.binary_score == "yes"' }],
          outputSchemaId: 'sch-ground',
          prompt: 'Facts: {documents}\n\nLLM generation: {generation}',
        },
      },
      {
        id: 'grounded',
        type: 'router',
        label: 'grounded?',
        detail: { stopMode: 'predicate', predLeft: 'grounded', predOp: 'truthy', reads: ['grounded'] },
      },
      {
        id: 'budget',
        type: 'router',
        label: 'budget spent?',
        detail: {
          stopMode: 'predicate',
          predLeft: 'attempts',
          predOp: '>=',
          predRightMode: 'const',
          predRight: 'MAX_ATTEMPTS',
          reads: ['attempts'],
        },
      },
      {
        id: 'grade_ans',
        type: 'action',
        label: 'grade_answer',
        detail: {
          kind: 'llm',
          reads: ['question', 'generation'],
          writes: [{ key: 'useful', op: 'set', expr: 'response.binary_score == "yes"' }],
          outputSchemaId: 'sch-ans',
          prompt: 'Question: {question}\n\nLLM generation: {generation}',
        },
      },
      {
        id: 'useful',
        type: 'router',
        label: 'useful?',
        detail: { stopMode: 'predicate', predLeft: 'useful', predOp: 'truthy', reads: ['useful'] },
      },
      { id: 'end', type: 'end', label: 'end' },
    ],
    edges: [
      { from: 'start', to: 'route' },
      { from: 'route', to: 'in_corpus' },
      { from: 'in_corpus', to: 'retrieve', label: 'yes' },
      { from: 'in_corpus', to: 'web', label: 'no' },
      { from: 'retrieve', to: 'grade_docs' },
      { from: 'grade_docs', to: 'docs_ok' },
      { from: 'docs_ok', to: 'gen', label: 'yes' },
      { from: 'docs_ok', to: 'web', label: 'no' },
      { from: 'web', to: 'gen' },
      { from: 'gen', to: 'grade_gen' },
      { from: 'grade_gen', to: 'grounded' },
      { from: 'grounded', to: 'grade_ans', label: 'yes' },
      { from: 'grounded', to: 'budget', label: 'no' },
      { from: 'budget', to: 'end', label: 'yes' },
      { from: 'budget', to: 'gen', label: 'no' },
      { from: 'grade_ans', to: 'useful' },
      { from: 'useful', to: 'end', label: 'yes' },
      { from: 'useful', to: 'web', label: 'no' },
    ],
  };
}

const inCorpus = await runGraph(adaptiveRagGraph(), 'What is agent memory?', defaultMockAdapters);
assert.equal(inCorpus.error || '', '');
const inPath = inCorpus.trace.map(s => s.label + (s.branch ? ':' + s.branch : ''));
assert.ok(!inPath.includes('web_search'), 'in-corpus should not web-search: ' + inPath.join(' > '));
assert.ok(inPath.includes('retrieve'), inPath.join(' > '));
assert.ok(inPath.includes('in corpus?:yes'), inPath.join(' > '));
assert.ok(Array.isArray(inCorpus.state.documents) && inCorpus.state.documents.length > 0);
assert.equal(inCorpus.state.use_vectorstore, true);

const offCorpus = await runGraph(adaptiveRagGraph(), 'Who won Wimbledon 2024?', defaultMockAdapters);
assert.equal(offCorpus.error || '', '');
const offPath = offCorpus.trace.map(s => s.label + (s.branch ? ':' + s.branch : ''));
assert.ok(offPath.includes('in corpus?:no'), offPath.join(' > '));
assert.ok(offPath.includes('web_search'), 'off-corpus should call Tavily: ' + offPath.join(' > '));
assert.ok(!offPath.includes('retrieve'), offPath.join(' > '));
const webStep = offCorpus.trace.find(s => s.label === 'web_search');
assert.ok(webStep && webStep.tool && webStep.tool.queries.some(q => /wimbledon/i.test(q)));
assert.ok(Array.isArray(offCorpus.state.documents) && offCorpus.state.documents.length > 0, 'Tavily should write documents');
assert.equal(offCorpus.state.use_vectorstore, false);

const andEmpty = {
  predLeft: 'documents',
  predOp: 'empty',
  predJoin: 'and',
  predExtra: [{ left: 'notes', op: 'empty', rightMode: 'literal', right: '' }],
};
assert.equal(evalPredicate({ documents: [], notes: '' }, andEmpty), true);
assert.equal(evalPredicate({ documents: ['x'], notes: '' }, andEmpty), false);
assert.equal(evalPredicate({ documents: [], notes: 'kept' }, andEmpty), false);
assert.equal(formatPredicate(andEmpty), 'documents is empty and notes is empty');
assert.equal(evalPredicate({ documents: ['x'], notes: '' }, { ...andEmpty, predJoin: 'or' }), true);
assert.equal(evalPredicate({ docs: {} }, { predLeft: 'docs', predOp: 'empty' }), true);
assert.equal(evalPredicate({ docs: ['a'] }, { predLeft: 'docs', predOp: 'not_empty' }), true);

function andGateGraph() {
  return {
    version: 2,
    stateVars: [
      { key: 'documents', val: '[]', type: 'list' },
      { key: 'notes', val: '', type: 'str' },
    ],
    nodes: [
      { id: 'start', type: 'start', label: 'start' },
      {
        id: 'gate',
        type: 'router',
        label: 'both empty?',
        detail: {
          stopMode: 'predicate',
          predLeft: 'documents',
          predOp: 'empty',
          predJoin: 'and',
          predExtra: [{ left: 'notes', op: 'empty', rightMode: 'literal', right: '' }],
        },
      },
      { id: 'search', type: 'action', label: 'search', detail: { kind: 'function', writes: [] } },
      { id: 'end', type: 'end', label: 'end' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'gate' },
      { id: 'e2', from: 'gate', to: 'end', label: 'si' },
      { id: 'e3', from: 'gate', to: 'search', label: 'no' },
      { id: 'e4', from: 'search', to: 'end' },
    ],
  };
}

const bothEmpty = await runGraph(andGateGraph(), '');
assert.ok(bothEmpty.trace.some(s => s.label === 'both empty?' && s.branch === 'si'), JSON.stringify(bothEmpty.trace));
assert.ok(!bothEmpty.trace.some(s => s.label === 'search'));

const oneFilled = andGateGraph();
oneFilled.stateVars[1].val = 'already have notes';
const routed = await runGraph(oneFilled, '');
assert.ok(routed.trace.some(s => s.label === 'both empty?' && s.branch === 'no'), JSON.stringify(routed.trace));
assert.ok(routed.trace.some(s => s.label === 'search'));

function joinReportsGraph(opts) {
  const skipClfWrite = opts && opts.skipClfWrite;
  return {
    version: 2,
    stateVars: [
      { key: 'reporte_habilitaciones', val: '', type: 'str' },
      { key: 'reporte_clasificacion', val: '', type: 'str' },
    ],
    nodes: [
      { id: 'start', type: 'start', label: 'start' },
      {
        id: 'hab',
        type: 'action',
        label: 'habilitaciones',
        detail: {
          kind: 'function',
          writes: [{ key: 'reporte_habilitaciones', op: 'set', expr: '"hab-ok"' }],
        },
      },
      {
        id: 'clf',
        type: 'action',
        label: 'clasificacion',
        detail: {
          kind: 'function',
          writes: skipClfWrite ? [] : [{ key: 'reporte_clasificacion', op: 'set', expr: '"clf-ok"' }],
        },
      },
      {
        id: 'gate',
        type: 'join',
        label: 'wait reports',
        detail: { waitKeys: ['reporte_habilitaciones', 'reporte_clasificacion'] },
      },
      { id: 'sup', type: 'action', label: 'supervisor', detail: { kind: 'function', writes: [] } },
      { id: 'end', type: 'end', label: 'end' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'hab' },
      { id: 'e2', from: 'start', to: 'clf' },
      { id: 'e3', from: 'hab', to: 'gate' },
      { id: 'e4', from: 'clf', to: 'gate' },
      { id: 'e5', from: 'gate', to: 'sup' },
      { id: 'e6', from: 'sup', to: 'end' },
    ],
  };
}

const bothReports = await runGraph(joinReportsGraph(), '');
assert.equal(bothReports.error || '', '');
const bothPath = bothReports.trace.map(s => s.label);
assert.ok(bothPath.includes('habilitaciones'), bothPath.join(' > '));
assert.ok(bothPath.includes('clasificacion'), bothPath.join(' > '));
assert.ok(bothPath.includes('wait reports'), bothPath.join(' > '));
assert.ok(bothPath.indexOf('supervisor') > bothPath.indexOf('wait reports'), bothPath.join(' > '));
const joinStep = bothReports.trace.find(s => s.type === 'join');
assert.equal(joinStep && joinStep.status, 'released');
assert.ok(/barrier released/i.test((joinStep && joinStep.note) || ''));
assert.equal(bothReports.state.reporte_habilitaciones, 'hab-ok');
assert.equal(bothReports.state.reporte_clasificacion, 'clf-ok');

const missingClf = await runGraph(joinReportsGraph({ skipClfWrite: true }), '');
assert.match(missingClf.error || '', /reporte_clasificacion/);
assert.ok(!missingClf.trace.some(s => s.label === 'supervisor'), 'supervisor must not run with one report');

function joinLlmIdentityWritesGraph() {
  return {
    version: 2,
    stateVars: [
      { key: 'reporte_habilitaciones', val: '', type: 'str' },
      { key: 'reporte_clasificacion', val: '', type: 'str' },
    ],
    schemas: [
      {
        id: 'sch-rep',
        name: 'Report',
        fields: [{ key: 'answer', type: 'str' }],
      },
    ],
    nodes: [
      { id: 'start', type: 'start', label: 'start' },
      {
        id: 'hab',
        type: 'action',
        label: 'habilitaciones',
        detail: {
          kind: 'llm',
          writes: [{ key: 'reporte_habilitaciones', op: 'set', expr: 'state["reporte_habilitaciones"]' }],
          outputSchemaId: 'sch-rep',
        },
      },
      {
        id: 'clf',
        type: 'action',
        label: 'clasificacion',
        detail: {
          kind: 'llm',
          writes: [{ key: 'reporte_clasificacion', op: 'set', expr: 'state["reporte_clasificacion"]' }],
          outputSchemaId: 'sch-rep',
        },
      },
      {
        id: 'gate',
        type: 'join',
        label: 'wait reports',
        detail: { waitKeys: ['reporte_habilitaciones', 'reporte_clasificacion'] },
      },
      { id: 'sup', type: 'action', label: 'supervisor', detail: { kind: 'function', writes: [] } },
      { id: 'end', type: 'end', label: 'end' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'hab' },
      { id: 'e2', from: 'start', to: 'clf' },
      { id: 'e3', from: 'hab', to: 'gate' },
      { id: 'e4', from: 'clf', to: 'gate' },
      { id: 'e5', from: 'gate', to: 'sup' },
      { id: 'e6', from: 'sup', to: 'end' },
    ],
  };
}

const llmJoin = await runGraph(joinLlmIdentityWritesGraph(), 'clasificar el expediente');
assert.equal(llmJoin.error || '', '', llmJoin.error);
assert.ok(!isEmptyish(llmJoin.state.reporte_habilitaciones), 'hab write should keep LLM output');
assert.ok(!isEmptyish(llmJoin.state.reporte_clasificacion), 'clf write should keep LLM output');
assert.ok(llmJoin.trace.some(s => s.type === 'join' && s.status === 'released'));
assert.ok(llmJoin.trace.some(s => s.label === 'supervisor'));

function isEmptyish(v) {
  return v == null || v === '';
}

function joinRouterAlternateEntriesGraph() {
  return {
    version: 2,
    stateVars: [
      { key: 'ncm_info', val: '', type: 'str' },
      { key: 'hab_info', val: '', type: 'str' },
      { key: 'generation_ok', val: 'true', type: 'bool' },
    ],
    nodes: [
      { id: 'start', type: 'start', label: 'start' },
      {
        id: 'clf',
        type: 'action',
        label: 'clasificador_ncm',
        detail: { kind: 'function', writes: [{ key: 'ncm_info', op: 'set', expr: '"ncm-ok"' }] },
      },
      {
        id: 'grounded',
        type: 'router',
        label: 'grounded?',
        detail: { predLeft: 'generation_ok', predOp: 'truthy', stopMode: 'predicate' },
      },
      {
        id: 'budget',
        type: 'router',
        label: 'budget spent?',
        detail: { predLeft: 'generation_ok', predOp: 'empty', stopMode: 'predicate' },
      },
      {
        id: 'hab',
        type: 'action',
        label: 'analista_habilitaciones',
        detail: { kind: 'function', writes: [{ key: 'hab_info', op: 'set', expr: '"hab-ok"' }] },
      },
      {
        id: 'gate',
        type: 'join',
        label: 'join',
        detail: { waitKeys: ['ncm_info', 'hab_info'] },
      },
      { id: 'orch', type: 'action', label: 'orquestador', detail: { kind: 'function', writes: [] } },
      { id: 'end', type: 'end', label: 'end' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'clf' },
      { id: 'e2', from: 'clf', to: 'grounded' },
      { id: 'e3', from: 'grounded', to: 'gate', label: 'yes' },
      { id: 'e4', from: 'grounded', to: 'budget', label: 'no' },
      { id: 'e5', from: 'budget', to: 'clf', label: 'no' },
      { id: 'e6', from: 'budget', to: 'gate', label: 'yes' },
      { id: 'e7', from: 'hab', to: 'gate' },
      { id: 'e8', from: 'gate', to: 'orch' },
      { id: 'e9', from: 'orch', to: 'end' },
    ],
  };
}

const altJoin = await runGraph(joinRouterAlternateEntriesGraph(), '');
assert.equal(altJoin.error || '', '', altJoin.error);
assert.ok(altJoin.trace.some(s => s.type === 'join' && s.status === 'released'), JSON.stringify(altJoin.trace.map(s => s.label + ':' + (s.status || s.type))));
assert.ok(altJoin.trace.some(s => s.label === 'analista_habilitaciones'));
assert.ok(altJoin.trace.some(s => s.label === 'orquestador'));
assert.ok(!altJoin.trace.some(s => s.label === 'budget spent?'), 'must not re-enter the unused budget router');

const floatState = initRunState({
  stateVars: [
    { key: 'precio_ref', val: '12.5', type: 'float' },
    { key: 'attempts', val: '2', type: 'int' },
  ],
}, '');
assert.equal(floatState.precio_ref, 12.5);
assert.equal(typeof floatState.precio_ref, 'number');
assert.equal(floatState.attempts, 2);
assert.equal(evalPredicate({ precio_ref: 12.5 }, {
  predLeft: 'precio_ref',
  predOp: '>',
  predRightMode: 'literal',
  predRight: '12.4',
}), true);
assert.equal(evalPredicate({ precio_ref: 12.5 }, {
  predLeft: 'precio_ref',
  predOp: '<',
  predRightMode: 'literal',
  predRight: '12.4',
}), false);

assert.equal(evalPredicate({ attempts: 3 }, {
  predLeft: 'attempts',
  predOp: '>=',
  predRightMode: 'const',
  predRight: 'MAX_ATTEMPTS',
}, [{ key: 'MAX_ATTEMPTS', type: 'int', val: '3' }]), true);
assert.equal(evalPredicate({ attempts: 2 }, {
  predLeft: 'attempts',
  predOp: '>=',
  predRightMode: 'const',
  predRight: 'MAX_ATTEMPTS',
}, [{ key: 'MAX_ATTEMPTS', type: 'int', val: '3' }]), false);

const budgetLoop = await runGraph({
  consts: [{ key: 'MAX_ATTEMPTS', type: 'int', val: '2' }],
  stateVars: [{ key: 'attempts', val: '0', type: 'int' }],
  nodes: [
    { id: 'start', type: 'start', label: 'start' },
    { id: 'tick', type: 'action', label: 'tick', detail: { kind: 'function', writes: [{ key: 'attempts', op: 'increment' }] } },
    {
      id: 'budget',
      type: 'router',
      label: 'budget spent?',
      detail: {
        stopMode: 'predicate',
        predLeft: 'attempts',
        predOp: '>=',
        predRightMode: 'const',
        predRight: 'MAX_ATTEMPTS',
      },
    },
    { id: 'end', type: 'end', label: 'end' },
  ],
  edges: [
    { from: 'start', to: 'tick' },
    { from: 'tick', to: 'budget' },
    { from: 'budget', to: 'end', label: 'yes' },
    { from: 'budget', to: 'tick', label: 'no' },
  ],
}, 'go');
assert.equal(budgetLoop.error || '', '');
assert.equal(budgetLoop.state.attempts, 2);
assert.ok(budgetLoop.trace.filter(s => s.label === 'tick').length === 2, JSON.stringify(budgetLoop.trace.map(s => s.label)));

console.log('run-graph tests ok');
