import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseModelJSON} from '../src/model-json.mjs';

const code = 'function draw() { return {x: "https://example.com/**/", y: [1, 2,], z: "\\\"}"}; /* keep */ }';

test('valid JSON follows the strict path without rewriting animation source or narration', () => {
  const expected = {code, narration: '这句旁白提到 // 和 /* */。'};
  assert.deepEqual(parseModelJSON(JSON.stringify(expected)), {value: expected, repairs: []});
});

test('repairs one wrapped object, comments and trailing commas without touching its fields', () => {
  const reply = [
    'Here is the requested data:',
    '```json',
    '{',
    '  // Outside the JSON strings',
    '  "segments": [{"text":"旁白",},],',
    '  "code": ' + JSON.stringify(code) + ', /* another comment */',
    '}',
    '```',
    'End of response.',
  ].join('\n');
  assert.deepEqual(parseModelJSON(reply), {
    value: {segments: [{text: '旁白'}], code},
    repairs: ['markdown_fence', 'surrounding_text', 'comments', 'trailing_commas'],
  });
  assert.deepEqual(parseModelJSON('生成结果如下：\n{"ok":true}\n完成。'), {
    value: {ok: true}, repairs: ['surrounding_text'],
  });
  assert.deepEqual(parseModelJSON('```JSON\n{"ok":true}\n```'), {value: {ok: true}, repairs: ['markdown_fence']});
});

test('rejects competing objects, truncated replies, and malformed values without guessing', () => {
  for (const reply of [
    '[{"a":1}]', 'null', 'prefix {"a":1} or {"b":2}',
    '```json\n{"a":1}\n```\n```json\n{"b":2}\n```',
    '{"segments":[{"text":"Incomplete"}', '{"a":/* absent */}', '{"a":[,]}', '{"a":[1,,]}', '{"a":tr/* comment */ue}',
    '{"a":true /* unclosed comment}', '{"a":"Unclosed string}',
  ]) assert.throws(() => parseModelJSON(reply), {name: 'SyntaxError'}, reply);
});

test('oversize malformed responses are bounded while strict JSON remains supported', () => {
  const payload = '中'.repeat(700_000);
  assert.throws(() => parseModelJSON(JSON.stringify({payload}).replace(/}$/, ',}')), {name: 'SyntaxError'});
  assert.equal(parseModelJSON(JSON.stringify({payload})).value.payload.length, payload.length);
  assert.throws(() => parseModelJSON('```json' + ' '.repeat(1_000_000) + '{'), {name: 'SyntaxError'});
});
