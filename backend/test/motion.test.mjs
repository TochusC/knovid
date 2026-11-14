import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const storage = await mkdtemp(join(tmpdir(), 'knovid-motion-'));
process.env.KNOVID_DATA = storage;
process.env.KNOVID_MODE = 'live';
process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.LLM_API_KEY = 'local-test-only';
process.env.LLM_PLAN_MODEL = 'test-plan';
process.env.LLM_FAST_MODEL = 'test-fast';
process.env.LLM_MOTION_MODEL = 'test-motion';
const {makeMotion} = await import('../src/activities/agents.mjs');
const {json, projectDir, read, revisionDir, sceneDir} = await import('../src/common.mjs');
const {patchScene} = await import('../src/contracts.mjs');

const code = 'function renderFrame({ctx, params}) {\n' +
  '// long scene code\n'.repeat(1500) +
  'if (params.showLabels) ctx.lineWidth = params.line_width; }';
const showLabels = {type: 'boolean', label: '显示标签', default: true};
const lineWidth = {type: 'number', label: '线宽', min: 1, max: 6, default: 3};

test('motion generation validates parameter specs and preserves the names used by render code and edits', async t => {
  t.after(() => rm(storage, {recursive: true, force: true}));
  const job = {projectId: '1315f1bc-5790-43ed-8112-7ace1031a602', revisionId: 'b42fe2a0-ef08-4227-8620-f1b54f85974c'};
  const dir = revisionDir(job);
  await json(join(projectDir(job.projectId), 'input.json'), {options: {language: 'zh'}});
  await json(join(dir, 'plan.json'), {title: 'Title', artDirection: 'Direction', scenes: [
    {id: 's1', evidenceIds: ['e1']}, {id: 's2', evidenceIds: ['e1']},
  ]});
  await json(join(dir, 'evidence.json'), {evidence: [{id: 'e1', quote: 'Evidence'}], figures: []});
  const requests = [];
  const responses = [
    {constructor: showLabels},
    {showLabels, line_width: lineWidth},
    {showLabels: true},
    {showLabels: true},
  ];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return Response.json({choices: [{message: {content: JSON.stringify({paramSchema: responses.shift(), code})}}]});
  });

  await makeMotion(job, 's1', null, AbortSignal.timeout(5000));
  const scene = sceneDir(job, 's1');
  const program = await read(join(scene, 'program.json'));
  assert.deepEqual(program.paramSchema, {showLabels, line_width: lineWidth});
  assert.deepEqual(program.params, {showLabels: true, line_width: 3});
  assert.ok((await readFile(join(scene, 'scene.mjs'), 'utf8')).endsWith('export ' + code + '\n'));
  assert.deepEqual(patchScene({baseRevisionId: job.revisionId, params: {showLabels: false, line_width: 5}}, program.paramSchema, 'zh'),
    {params: {showLabels: false, line_width: 5}});
  assert.match(requests[0].messages[0].content, /lowerCamelCase or snake_case/);
  assert.match(requests[0].messages[0].content, /"showLabels":\{"type":"boolean"/);
  assert.match(JSON.parse(requests[1].messages[1].content).schemaCorrection, /non-reserved ASCII parameter name/);

  await assert.rejects(makeMotion(job, 's2', null, AbortSignal.timeout(5000)), {
    code: 'LLM_SCHEMA',
    message: /Each parameter needs a spec object/,
  });
  assert.match(JSON.parse(requests[3].messages[1].content).schemaCorrection, /Each parameter needs a spec object/);
});
