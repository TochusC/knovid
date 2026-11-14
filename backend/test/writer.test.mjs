import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'knovid-writer-'));
process.env.KNOVID_DATA = root;
process.env.KNOVID_MODE = 'live';
process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.LLM_API_KEY = 'local-test-only';
process.env.LLM_PLAN_MODEL = 'test-plan';
process.env.LLM_FAST_MODEL = 'test-fast';
const {writeScript} = await import('../src/activities/agents.mjs');
const {json, projectDir, read, revisionDir, sceneDir} = await import('../src/common.mjs');
after(() => rm(root, {recursive: true, force: true}));

const response = content => Response.json({choices: [{message: {content}}]});
const valid = {cue: 'observe', text: '客户端发出查询后收到响应。', pauseMs: 160};

async function prepareScene({trial = false} = {}) {
  const job = {projectId: randomUUID(), revisionId: randomUUID()};
  const dir = revisionDir(job);
  await Promise.all([
    json(join(projectDir(job.projectId), 'input.json'), {options: {
      language: 'zh', sceneCount: 3, ...(trial ? {maxDurationSeconds: 30} : {}),
    }}),
    json(join(dir, 'plan.json'), {
      title: '一次 DNS 查询',
      artDirection: '白底线条示意',
      scenes: [{id: 's1', title: '理解查询', visual: '展示发送和接收', cues: ['observe'], evidenceIds: ['e1']}],
    }),
    json(join(dir, 'evidence.json'), {evidence: [{id: 'e1', quote: 'The client sends a query and receives a response.'}], figures: []}),
    json(join(dir, 'voice.json'), {direction: '用自然的停顿'}),
  ]);
  return {job, path: join(sceneDir(job, 's1'), 'script.json')};
}

test('Writer recovers malformed replies and saves only validated narration with its evidence', async t => {
  const {job, path} = await prepareScene();
  const prompts = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const {messages} = JSON.parse(request.body);
    const input = JSON.parse(messages[1].content);
    prompts.push(input);
    assert.match(messages[0].content, /copy each cue identifier verbatim/);
    assert.deepEqual(input.scene.cues, ['observe']);
    assert.equal(input.evidence[0].id, 'e1');
    if (prompts.length <= 2) return response('Opening line without any machine-readable object.');
    return response(JSON.stringify({segments: [{...valid, text: '  ' + valid.text + '  '}]}));
  });

  await writeScript(job, 's1', AbortSignal.timeout(7000));
  assert.equal(prompts.length, 3);
  assert.match(prompts[1].schemaCorrection, /JSON object/);
  assert.match(prompts[2].schemaCorrection, /JSON object/);
  assert.deepEqual(await read(path), {segments: [valid], evidenceIds: ['e1'], model: 'test-plan'});
});

test('Writer retries overlong guest pronunciation while keeping cue and subtitle intact', async t => {
  const {job, path} = await prepareScene({trial: true});
  const prompts = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const {messages} = JSON.parse(request.body);
    const input = JSON.parse(messages[1].content);
    prompts.push(input);
    const speak = '客户端发出查询后收到响应这一件事情。'.repeat(2);
    return response(JSON.stringify({segments: [prompts.length === 1 ? {...valid, speak} : valid]}));
  });
  await writeScript(job, 's1', AbortSignal.timeout(7000));
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].schemaCorrection, /narrationCharacterLimit/);
  assert.deepEqual((await read(path)).segments, [valid]);
});
