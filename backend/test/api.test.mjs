import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'knovid-test-'));
process.env.KNOVID_EXECUTOR = 'local';
process.env.KNOVID_MODE = 'fixture';
process.env.KNOVID_DATA = root;
process.env.KNOVID_LOCAL_RENDERER = 'chromium';
process.env.RENDER_CHUNK_FRAMES = '42';
process.env.API_TOKEN = 'test-api-token';
const {createApp} = await import('../src/api.mjs');
const {media, sleep} = await import('../src/common.mjs');

async function withAPI(callback, executor) {
  const app = await createApp({executor, authenticate: async () => ({id: 'api-test-member'})});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const request = (url, init = {}, authenticated = true) => fetch(base + url, {
    ...init, headers: {
      ...(authenticated ? {authorization: 'Bearer test-api-token'} : {}),
      ...init.headers,
    },
  });
  const send = (url, method, body) => request(url, {
    method, headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
  });
  try {
    await callback(request, send);
  } finally {
    await app.executor.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
  }
}

const topic = {input: {type: 'topic', topic: '开普勒定律'}, options: {size: '360p', sceneCount: 3, language: 'zh'}};

try {
  await test('REST validates input and guards concurrent project state changes', async () => {
    const started = new Set();
    const scheduled = [];
    const fake = {
      async start(job) { started.add(job.revisionId); scheduled.push(job); },
      async cancel(job) {
        const {json, revisionDir} = await import('../src/common.mjs');
        await json(join(revisionDir(job), 'status.json'), {status: 'cancelled', stage: 'cancelled', error: null});
      },
      async close() {},
    };
    await withAPI(async (request, send) => {
      assert.equal((await request('/healthz', {}, false)).status, 200);
      assert.equal((await request('/v1/projects', {}, false)).status, 401);
      assert.equal((await request('/openapi.json')).status, 200);
      const sound = await (await request('/v1/audio/catalog')).json();
      assert.equal(sound.voices.zh[0].voice, 'zh-CN-YunxiNeural');
      assert.ok(sound.music.every(asset => asset.license === 'CC0-1.0'));
      assert.equal((await send('/v1/projects', 'POST', {...topic, options: {sceneCount: 33}})).status, 400);
      assert.equal((await send('/v1/projects', 'POST', {input: {type: 'paper-url', url: 'https://127.0.0.1/paper.pdf'}})).status, 400);
      assert.equal((await request('/v1/projects', {method: 'POST', headers: {'content-type': 'application/pdf'}, body: 'invalid'})).status, 400);
      const response = await send('/v1/projects', 'POST', topic);
      assert.equal(response.status, 202);
      const {projectId, revisionId, href} = await response.json();
      assert.equal(response.headers.get('location'), href);
      assert.equal(started.size, 1);
      assert.equal((await send('/v1/projects/' + projectId + '/scenes/s1', 'PATCH', {baseRevisionId: revisionId, narration: '修改'})).status, 409);
      assert.equal((await request(href + '/artifacts/video.mp4')).status, 404);
      assert.equal((await request(href + '/cancel', {method: 'POST'})).status, 202);
      assert.equal((await (await request(href)).json()).status, 'cancelled');
      const retry = await request(href + '/retry', {method: 'POST'});
      assert.equal(retry.status, 202);
      assert.notEqual((await retry.json()).revisionId, revisionId);
      assert.equal(scheduled.length, 2);
      assert.equal((await request(href + '/retry', {method: 'POST'})).status, 409);
    }, fake);
    await rm(join(root, 'projects'), {recursive: true, force: true});
  });

  await test('members can create 32 scenes and edit or stream a two-digit scene ID', async () => {
    const fake = {async start() {}, async close() {}};
    const {json, projectDir, revisionDir, sceneDir} = await import('../src/common.mjs');
    await withAPI(async (request, send) => {
      const response = await send('/v1/projects', 'POST', {...topic, options: {sceneCount: 32}});
      assert.equal(response.status, 202);
      const job = await response.json();
      const project = JSON.parse(await readFile(join(projectDir(job.projectId), 'input.json')));
      assert.equal(project.options.sceneCount, 32);
      await json(join(revisionDir(job), 'plan.json'), {scenes: Array.from({length: 32}, (_, i) => ({id: 's' + (i + 1)}))});
      await json(join(revisionDir(job), 'status.json'), {status: 'succeeded'});
      await json(join(sceneDir(job, 's32'), 'program.json'), {
        paramSchema: {radius: {type: 'number', min: 0, max: 2}}, params: {radius: 1},
      });
      await writeFile(join(sceneDir(job, 's32'), 'preview.mp4'), 'fixture-scene-video');
      const path = job.href + '/scenes/s32/artifacts/preview.mp4';
      const clip = await request(path, {headers: {range: 'bytes=0-6'}});
      assert.equal(clip.status, 206);
      assert.equal(await clip.text(), 'fixture');
      assert.equal((await request(path.replace('/s32/', '/s33/'))).status, 404);
      const editPath = '/v1/projects/' + job.projectId + '/scenes/s32';
      const patch = {baseRevisionId: job.revisionId, params: {radius: 1.5}};
      assert.equal((await send(editPath, 'PATCH', patch)).status, 202);
    }, fake);
    await rm(join(root, 'projects'), {recursive: true, force: true});
  });

  await test('saved styles can be edited and reused by a project after deletion', async () => {
    const fake = {async start() {}, async close() {}};
    const {projectDir, read} = await import('../src/common.mjs');
    const styles = '/v1/rixin/styles';
    await withAPI(async (request, send) => {
      const created = await send(styles, 'POST', {style: '蓝图', summary: '白底蓝色线稿'});
      assert.equal(created.status, 201);
      const {id} = await created.json();
      assert.equal((await send(styles, 'POST', {style: '蓝图', summary: '备用样式'})).status, 409);
      const revised = {style: '蓝图', summary: '紫色线稿与逐步标注'};
      assert.equal((await send(styles + '/' + id, 'PATCH', revised)).status, 200);
      assert.deepEqual((await (await request(styles)).json()).presets, [{id, ...revised}]);
      const project = await send('/v1/projects', 'POST', {...topic, options: {...topic.options, stylePresetId: id}});
      assert.equal(project.status, 202);
      const {projectId} = await project.json();
      assert.equal((await request(styles + '/' + id, {method: 'DELETE'})).status, 200);
      assert.deepEqual((await (await request(styles)).json()).presets, []);
      const {options} = await read(join(projectDir(projectId), 'input.json'));
      assert.equal(options.styleSelection.summary, revised.summary);
    }, fake);
    await rm(join(root, 'projects'), {recursive: true, force: true});
  });

  await test('fixture renders speech, subtitles and frame ranges and reuses an unchanged scene', {
    skip: process.env.KNOVID_TEST_RENDER !== '1', timeout: 100_000,
  }, async () => {
    async function ready(request, href) {
      for (let tries = 0; tries < 500; tries++) {
        const state = await (await request(href)).json();
        if (state.status === 'succeeded') return state;
        assert.notEqual(state.status, 'failed', JSON.stringify(state.error));
        await sleep(150);
      }
      assert.fail('Revision did not complete');
    }
    await withAPI(async (request, send) => {
      const result = await send('/v1/projects', 'POST', topic);
      assert.equal(result.status, 202);
      const first = await result.json();
      const state = await ready(request, first.href);
      assert.equal(state.scenes.length, 3);
      assert.equal(state.scenes.every(scene => scene.status === 'ready'), true);
      const manifest = await (await request(state.artifacts['manifest.json'])).json();
      assert.equal(manifest.scenes.every(scene => scene.hasSpeech), true);
      assert.equal(manifest.sound.music.id, 'first-light');
      assert.ok(manifest.sound.effects.length >= 2);
      const localArtifact = (revision, ...parts) => join(root, 'projects', first.projectId, 'revisions', revision, ...parts);
      const output = await media(localArtifact(first.revisionId, 'video.mp4'));
      assert.equal(Number(output.streams[0].nb_frames), manifest.durationFrames);
      assert.equal(output.streams[1].codec_name, 'aac');
      const range = await request(state.artifacts['video.mp4'], {headers: {range: 'bytes=0-31'}});
      assert.equal(range.status, 206);
      assert.equal((await range.arrayBuffer()).byteLength, 32);
      assert.equal((await request(state.artifacts['video.mp4'], {headers: {range: 'bytes=-0'}})).status, 416);
      const subtitles = await (await request(state.artifacts['subtitles.vtt'])).text();
      assert.match(subtitles, /WEBVTT[\s\S]*椭圆[\s\S]*越靠近太阳/);
      const before = await stat(localArtifact(first.revisionId, 'scenes', 's2', 'preview.mp4'));
      const editPath = '/v1/projects/' + first.projectId + '/scenes/s1';
      const edits = await Promise.all([0.4, 0.65].map(eccentricity => send(editPath, 'PATCH', {
        baseRevisionId: first.revisionId, params: {eccentricity},
      })));
      assert.deepEqual(edits.map(response => response.status).sort(), [202, 409]);
      const second = await edits.find(response => response.status === 202).json();
      const revised = await ready(request, second.href);
      assert.equal(revised.sourceRevisionId, first.revisionId);
      const after = await stat(localArtifact(second.revisionId, 'scenes', 's2', 'preview.mp4'));
      assert.equal(before.ino, after.ino);
      const beforeVoice = await stat(localArtifact(first.revisionId, 'scenes', 's1', 'audio.wav'));
      const afterVoice = await stat(localArtifact(second.revisionId, 'scenes', 's1', 'audio.wav'));
      assert.equal(beforeVoice.ino, afterVoice.ino);
      const thirdResponse = await send(editPath, 'PATCH', {baseRevisionId: second.revisionId, narration: '相同时间里，行星和太阳的连线扫过相同面积。'});
      assert.equal(thirdResponse.status, 202);
      const third = await thirdResponse.json();
      const changed = await ready(request, third.href);
      const updated = await (await request(changed.artifacts['manifest.json'])).json();
      assert.notEqual(updated.scenes[1].startFrame, manifest.scenes[1].startFrame);
      assert.notEqual((await stat(localArtifact(third.revisionId, 'scenes', 's1', 'audio.wav'))).ino, afterVoice.ino);
      assert.equal((await stat(localArtifact(third.revisionId, 'scenes', 's2', 'preview.mp4'))).ino, before.ino);
      const zip = await readFile(localArtifact(third.revisionId, 'project.zip'));
      assert.equal(zip.subarray(0, 2).toString(), 'PK');
      const rearranged = await send('/v1/projects/' + first.projectId, 'PATCH', {
        baseRevisionId: third.revisionId, sceneOrder: ['s2', 's3', 's1'], music: false, sound: {effects: false},
      });
      assert.equal(rearranged.status, 202);
      const fourth = await rearranged.json();
      const assembled = await ready(request, fourth.href);
      const timeline = await (await request(assembled.artifacts['manifest.json'])).json();
      assert.equal(timeline.options.music, false);
      assert.deepEqual(timeline.sound.credits, []);
      assert.deepEqual(timeline.scenes.map(scene => scene.id), ['s2', 's3', 's1']);
      assert.equal((await stat(localArtifact(fourth.revisionId, 'scenes', 's2', 'preview.mp4'))).ino, before.ino);
      if (process.env.KNOVID_TEST_OUTPUT) {
        const {copyFile} = await import('node:fs/promises');
        await copyFile(localArtifact(first.revisionId, 'video.mp4'), process.env.KNOVID_TEST_OUTPUT);
      }
    });
  });
} finally {
  await rm(root, {recursive: true, force: true});
}
