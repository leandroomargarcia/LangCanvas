import assert from 'node:assert/strict';
import { extractJsonValue, repairTruncatedJson, fieldsToGeminiSchema } from '../lib/gemini.js';

assert.deepEqual(extractJsonValue('{"a":1}'), { a: 1 });
assert.deepEqual(extractJsonValue('```json\n{"a":1}\n```'), { a: 1 });
assert.deepEqual(extractJsonValue('Here you go:\n{"answer":"ok","n":2}'), { answer: 'ok', n: 2 });

const repaired = extractJsonValue('{"answer":"half');
assert.deepEqual(repaired, { answer: 'half' });

const closed = repairTruncatedJson('{"answer":"hello');
assert.deepEqual(JSON.parse(closed), { answer: 'hello' });

const schema = fieldsToGeminiSchema([
  { key: 'answer', type: 'str' },
  { key: 'costo_total', type: 'float' },
  { key: 'search_queries', type: 'list[str]' },
  {
    key: 'reflection',
    type: 'schema:x',
    nestedFields: [
      { key: 'missing', type: 'str' },
      { key: 'superfluous', type: 'str' },
    ],
  },
]);
assert.equal(schema.type, 'OBJECT');
assert.equal(schema.properties.answer.type, 'STRING');
assert.equal(schema.properties.costo_total.type, 'NUMBER');
assert.equal(schema.properties.search_queries.type, 'ARRAY');
assert.equal(schema.properties.reflection.type, 'OBJECT');
assert.equal(schema.properties.reflection.properties.missing.type, 'STRING');

console.log('gemini-json tests ok');
