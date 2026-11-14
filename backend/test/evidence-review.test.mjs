import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'knovid-evidence-review-'));
process.env.KNOVID_DATA = root;
process.env.KNOVID_MODE = 'live';
process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.LLM_API_KEY = 'local-test-only';
process.env.LLM_PLAN_MODEL = 'test-plan';
process.env.LLM_FAST_MODEL = 'test-fast';
const {requireReview} = await import('../src/activities/agents.mjs');
const {json, projectDir, read, revisionDir, sceneDir} = await import('../src/common.mjs');
after(() => rm(root, {recursive: true, force: true}));

const originalVisual = '画一条持续下降的曲线。';
const firstRepair = '画带有百分比的柱状图。';
const approvedVisual = '并列展示发出查询与收到响应两个步骤，不加数字。';
const issues = ['材料没有提供下降趋势。', '材料没有提供可标注的百分比。'];
const originalSegments = [{cue: 'query', text: '查询率持续下降。', pauseMs: 180}];
const repairedSegments = [{cue: 'query', text: '客户端发出查询后收到响应。', pauseMs: 180}];
const response = answer => Response.json({choices: [{message: {content: JSON.stringify(answer)}}]});

async function createScene() {
  const job = {projectId: randomUUID(), revisionId: randomUUID()};
  const dir = revisionDir(job);
  const scene = sceneDir(job, 's1');
  const script = {segments: originalSegments, evidenceIds: ['e1'], model: 'test-fast'};
  const plan = {
    title: '一次 DNS 查询',
    artDirection: '白底线条示意',
    scenes: [{id: 's1', title: '理解查询', visual: originalVisual, cues: ['query'], evidenceIds: ['e1']}],
  };
  await Promise.all([
    json(join(projectDir(job.projectId), 'input.json'), {options: {language: 'zh'}}),
    json(join(dir, 'plan.json'), plan),
    json(join(dir, 'evidence.json'), {evidence: [{id: 'e1', quote: 'The client sends a query and receives a response.'}], figures: []}),
    json(join(scene, 'script.json'), script),
  ]);
  return {job, dir, scene, script, plan};
}

test('review repairs narration and visual together and only publishes the candidate that passes', async t => {
  const {job, dir, scene, script, plan} = await createScene();
  const reviewed = [];
  const repairs = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const {messages} = JSON.parse(request.body);
    const prompt = messages[0].content;
    const input = JSON.parse(messages[1].content);
    assert.deepEqual(await read(join(scene, 'script.json')), script);
    if (prompt.startsWith('You are the KnoVid Reviewer.')) {
      reviewed.push([input.scene.visual, input.segments[0].text]);
      const index = reviewed.length - 1;
      return response(index < issues.length ? {pass: false, issues: [issues[index]]} : {pass: true, issues: []});
    }
    assert.match(prompt, /^You are the KnoVid Scene revision\./);
    repairs.push(input.issues);
    return response({segments: repairedSegments, visual: repairs.length === 1 ? firstRepair : approvedVisual});
  });

  const result = await requireReview(job, 's1', AbortSignal.timeout(7000));
  assert.equal(result.visualChanged, true);
  assert.deepEqual(reviewed, [
    [originalVisual, originalSegments[0].text],
    [firstRepair, repairedSegments[0].text],
    [approvedVisual, repairedSegments[0].text],
  ]);
  assert.deepEqual(repairs, [[issues[0]], [issues[1]]]);
  const saved = await read(join(scene, 'script.json'));
  assert.deepEqual(saved.segments, repairedSegments);
  assert.equal(saved.visual, approvedVisual);
  assert.equal((await read(join(scene, 'review.json'))).pass, true);
  assert.deepEqual(await read(join(dir, 'plan.json')), plan);
  assert.equal((await requireReview(job, 's1', AbortSignal.timeout(7000))).visualChanged, true);
  assert.equal(reviewed.length, 3, 'a retried activity reuses the approval for the same scene');
});

test('repeatedly rejected repairs leave the original scene intact and stop after three attempts', async t => {
  const {job, scene, script} = await createScene();
  let reviews = 0;
  let repairs = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const prompt = JSON.parse(request.body).messages[0].content;
    if (prompt.startsWith('You are the KnoVid Reviewer.')) {
      reviews++;
      return response({pass: false, issues: ['缺少该数字的出处。']});
    }
    assert.match(prompt, /^You are the KnoVid Scene revision\./);
    repairs++;
    return response({segments: repairedSegments, visual: '画一个标有 ' + repairs + '% 的图表。'});
  });

  await assert.rejects(requireReview(job, 's1', AbortSignal.timeout(7000)), {code: 'EVIDENCE_REVIEW_FAILED'});
  assert.equal(reviews, 4);
  assert.equal(repairs, 3);
  assert.deepEqual(await read(join(scene, 'script.json')), script);
  assert.equal((await read(join(scene, 'review.json'))).pass, false);
});
