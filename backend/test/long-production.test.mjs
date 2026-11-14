import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {executePipeline} from '../src/pipeline.mjs';

const count = 32;
const ids = Array.from({length: count}, (_, i) => 's' + (i + 1));

const root = await mkdtemp(join(tmpdir(), 'knovid-plan-'));
after(() => rm(root, {recursive: true, force: true}));
process.env.KNOVID_DATA = root;
process.env.KNOVID_MODE = 'live';
process.env.LLM_BASE_URL = 'https://sec.llm.autos/v1';
process.env.LLM_API_KEY = 'fake-model-token';
process.env.LLM_PLAN_MODEL = 'glm-5.1-highspeed';
process.env.LLM_FAST_MODEL = 'glm-5.1-highspeed';
const {json, projectDir, read, revisionDir} = await import('../src/common.mjs');
const {makePlan} = await import('../src/activities/agents.mjs');
const {creation} = await import('../src/contracts.mjs');

test('the long Director expands a shared outline and retries a short chapter', async t => {
  const job = {projectId: 'project', revisionId: 'revision'};
  await json(join(projectDir(job.projectId), 'input.json'), {input: {title: 'Long plan'}, options: {sceneCount: count, language: 'en'}});
  await json(join(revisionDir(job), 'evidence.json'), {evidence: [{id: 'e1', quote: 'A source excerpt.'}], figures: []});
  const scenes = ids.map(id => ({title: id, goal: 'Explain this step', visual: 'Move the highlighted component', cues: ['focus'], evidenceIds: ['e1']}));
  scenes[0] = {...scenes[0],
    title: 'Orbit comparison '.repeat(4),
    goal: 'Explain this step. '.repeat(20),
    visual: 'Move the highlighted component. '.repeat(21),
    cues: [' Name-Typed ', 'NAME_TYPED', '镜头', 'post_query_' + 'a'.repeat(20)],
    evidenceIds: ['e1', 'unknown', 'e1'],
  };
  const chapters = ['Introduction', 'Mechanism. '.repeat(30), 'Case study', 'Conclusion'];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    const input = JSON.parse(body.messages[1].content);
    requests.push(input);
    const {chapterCount, firstScene, options, schemaCorrection} = input;
    const length = options.sceneCount - Number(firstScene === 1 && !schemaCorrection);
    const value = chapterCount ? {chapters} : {scenes: scenes.slice(firstScene - 1, firstScene - 1 + length)};
    return Response.json({choices: [{message: {content: JSON.stringify(value)}}]});
  });
  assert.deepEqual(await makePlan(job, AbortSignal.timeout(5000)), ids);
  const plan = await read(join(revisionDir(job), 'plan.json'));
  assert.equal(plan.title, 'Long plan');
  assert.equal(plan.audience, 'Curious general viewers');
  assert.match(plan.artDirection, /lavender/);
  assert.deepEqual(plan.scenes.map(scene => scene.id), ids);
  assert.deepEqual(plan.scenes.slice(1).map(scene => scene.title), ids.slice(1));
  assert.equal(plan.scenes[0].title, 'Orbit comparison Orbit comparison Orbit comparison Orbit');
  assert.ok(plan.scenes[0].goal.length <= 300 && plan.scenes[0].goal.endsWith('.'));
  assert.ok(plan.scenes[0].visual.length <= 600 && plan.scenes[0].visual.endsWith('.'));
  assert.deepEqual(plan.scenes[0].cues, ['name_typed', 'beat1', 'beat2', 'post_query_' + 'a'.repeat(12)]);
  assert.deepEqual(plan.scenes[0].evidenceIds, ['e1']);
  assert.equal(requests[0].chapterCount, chapters.length);
  const chapterRequests = requests.slice(1);
  assert.equal(chapterRequests.length, chapters.length + 1);
  assert.deepEqual(chapterRequests.filter(request => !request.schemaCorrection).map(request => request.firstScene).sort((a, b) => a - b), [1, 9, 17, 25]);
  for (const request of chapterRequests) {
    assert.equal(request.options.sceneCount, 8);
    assert.equal(request.chapterGoal, request.chapters[request.chapterNumber - 1]);
    assert.equal(request.chapters.length, 4);
    assert.ok(request.chapters[1].length <= 300 && request.chapters[1].endsWith('.'));
    assert.equal(request.artDirection, plan.artDirection);
  }
  assert.match(chapterRequests.find(request => request.schemaCorrection).schemaCorrection, /exactly 8 entries in scenes/);
});

test('the short Director accepts oversized metadata and retries an ungrounded scene', async t => {
  const job = {projectId: 'short-project', revisionId: 'revision'};
  const subject = '行星的轨道';
  const brief = [subject, '用两颗行星的运动说明轨道形状。'.repeat(25), '结尾留一秒给观众比较轨道。'].join('\n');
  const project = creation({input: {type: 'topic', topic: brief}, options: {sceneCount: 3, language: 'zh'}});
  await json(join(projectDir(job.projectId), 'input.json'), {
    ...project, options: {...project.options, maxDurationSeconds: 30},
  });
  await json(join(revisionDir(job), 'evidence.json'), {evidence: [{id: 'e1', quote: '行星沿椭圆轨道绕太阳运行。'}], figures: []});
  const artDirection = '浅紫色的背景与蓝色轨道标注。'.repeat(40);
  const scene = {title: '轨道演示', goal: '区分轨道形状', visual: '在图中绘制椭圆和焦点。', cues: ['show-orbit']};
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    const input = JSON.parse(body.messages[1].content);
    requests.push(input);
    const scenes = Array.from({length: 3}, (_, index) => ({
      ...scene, evidenceIds: index === 0 && !input.schemaCorrection ? ['e404'] : ['e404', 'e1', 'e1'],
    }));
    return Response.json({choices: [{message: {content: JSON.stringify({artDirection, scenes})}}]});
  });
  assert.deepEqual(await makePlan(job, AbortSignal.timeout(5000)), ['s1', 's2', 's3']);
  const plan = await read(join(revisionDir(job), 'plan.json'));
  assert.equal(plan.title, subject);
  assert.equal(plan.audience, '对主题感兴趣的普通观众');
  assert.notEqual(plan.artDirection, artDirection);
  assert.ok(plan.artDirection.length <= 450 && plan.artDirection.endsWith('。'));
  assert.ok(plan.scenes.every(scene => scene.cues.length === 1 && scene.cues[0] === 'show_orbit'));
  assert.ok(plan.scenes.every(scene => scene.evidenceIds.length === 1 && scene.evidenceIds[0] === 'e1'));
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.creativeIntent === brief));
  assert.match(requests[1].schemaCorrection, /at least one existing evidence ID/);
});

test('the Director receives closing directions from a brief split across model requests', async t => {
  const job = {projectId: 'long-brief-project', revisionId: 'revision'};
  const subject = 'Comparing transit maps';
  const closing = 'End with a side-by-side comparison of the two maps.';
  const reference = 'https://example.com/transit-maps';
  const brief = [
    '# ' + subject,
    ...Array.from({length: 400}, (_, index) =>
      `Observation ${index + 1}: Compare the same routes at different scales, starting with a city overview.`),
    closing,
    `[Reference maps](${reference})`,
  ].join('\n');
  const project = creation({input: {type: 'topic', topic: brief}, options: {sceneCount: 3, language: 'en'}});
  assert.equal(project.input.title, subject);
  assert.equal(project.input.brief, brief);
  assert.deepEqual(project.input.referenceUrls, [reference]);
  await json(join(projectDir(job.projectId), 'input.json'), project);
  await json(join(revisionDir(job), 'evidence.json'), {evidence: [{id: 'e1', quote: 'A source excerpt.'}], figures: []});
  const sections = [];
  const directorRequests = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const {messages} = JSON.parse(request.body);
    const input = JSON.parse(messages[1].content);
    let value;
    if (input.section) {
      sections.push(input.section);
      value = {summary: input.section.includes(closing) ? closing : 'Explain how map scale changes the view.'};
    } else {
      directorRequests.push(input);
      value = {scenes: Array.from({length: 3}, () => ({
        title: subject, goal: 'Show route changes', visual: 'Animate the two scales', cues: ['focus'], evidenceIds: ['e1'],
      }))};
    }
    return Response.json({choices: [{message: {content: JSON.stringify(value)}}]});
  });
  assert.deepEqual(await makePlan(job, AbortSignal.timeout(5000)), ['s1', 's2', 's3']);
  assert.ok(sections.length > 1);
  assert.equal(sections.sort((a, b) => brief.indexOf(a) - brief.indexOf(b)).join(''), brief);
  assert.equal(directorRequests.length, 1);
  assert.ok(directorRequests[0].creativeIntent.endsWith(closing));
});

test('large revisions cap scene and render queues and use long assembly', async () => {
  let scenes = 0;
  let maxScenes = 0;
  const chunks = new Map();
  let maxChunks = 0;
  const rendered = new Map();
  const completed = [];
  const noop = async () => {};
  const activities = {
    checkpoint: noop, acquire: noop, extractText: noop, extractFigures: noop, makeEvidence: noop,
    makePlan: async () => ids, directVoice: noop,
    writeScript: async () => {
      scenes++;
      maxScenes = Math.max(maxScenes, scenes);
    },
    requireReview: noop, synthesize: noop, makeMotion: noop, checkFrame: async () => ({ok: true}),
    renderInfo: async () => ({durationFrames: 475, heavy: true}),
    renderChunk: async (_job, id, start, end) => {
      chunks.set(id, (chunks.get(id) || 0) + 1);
      maxChunks = Math.max(maxChunks, chunks.get(id));
      await Promise.resolve();
      chunks.set(id, chunks.get(id) - 1);
      if (!rendered.has(id)) rendered.set(id, []);
      rendered.get(id).push([start, end]);
    },
    completeScene: async (_job, id) => {
      scenes--;
      completed.push(id);
    },
    assemble: async () => assert.fail('The long assembly deadline should be used'),
    assembleLong: async (_job, assembled) => assert.deepEqual(assembled, ids),
  };
  await executePipeline(activities, {chunkFrames: 200});
  assert.equal(maxScenes, 4);
  assert.equal(maxChunks, 2);
  assert.deepEqual(completed, ids);
  assert.deepEqual(rendered.get('s32'), [[0, 99], [100, 199], [200, 299], [300, 399], [400, 474]]);
});
