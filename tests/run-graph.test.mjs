import assert from 'node:assert/strict';
import { runGraph, flattenSchemaFields, interpolatePrompt, defaultMockAdapters } from '../lib/run-graph.js';

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

console.log('run-graph tests ok');
