import assert from 'node:assert/strict';
import {once} from 'node:events';
import {copyFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

await test('a complete guest fixture produces measured video below 30 seconds with speech', {
  skip: process.env.KNOVID_TEST_RENDER !== '1', timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knovid-guest-render-'));
  process.env.KNOVID_DATA = directory;
  process.env.KNOVID_MODE = 'fixture';
  process.env.KNOVID_EXECUTOR = 'local';
  process.env.KNOVID_LOCAL_RENDERER = 'chromium';
  delete process.env.API_TOKEN;
  const {createApp} = await import('../src/api.mjs');
  const {media, read, revisionDir, sleep} = await import('../src/common.mjs');
  const app = await createApp({authenticate: async () => null});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const access = await fetch(base + '/v1/access');
    const cookie = access.headers.get('set-cookie').split(';')[0];
    const response = await fetch(base + '/v1/projects', {
      method: 'POST', headers: {cookie, 'content-type': 'application/json'},
      body: JSON.stringify({input: {type: 'topic', topic: '开普勒定律'}, options: {size: '360p'}}),
    });
    assert.equal(response.status, 202);
    const job = await response.json();
    let state;
    for (let index = 0; index < 600; index++) {
      state = await (await fetch(base + job.href, {headers: {cookie}})).json();
      assert.notEqual(state.status, 'failed', JSON.stringify(state.error));
      if (state.status === 'succeeded') break;
      await sleep(150);
    }
    assert.equal(state.status, 'succeeded');
    const path = join(revisionDir(job), 'video.mp4');
    const output = await media(path);
    const manifest = await read(join(revisionDir(job), 'manifest.json'));
    assert.ok(Number(output.format.duration) > 0 && Number(output.format.duration) <= 30);
    assert.equal(manifest.options.maxDurationSeconds, 30);
    assert.equal(manifest.scenes.length, 3);
    assert.equal(manifest.scenes.every(scene => scene.hasSpeech), true);
    assert.ok(output.streams.some(stream => stream.codec_type === 'audio'));
    console.info('Guest fixture media duration:', output.format.duration, 'seconds');
    if (process.env.KNOVID_GUEST_TEST_OUTPUT) await copyFile(path, process.env.KNOVID_GUEST_TEST_OUTPUT);
  } finally {
    await app.executor.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await rm(directory, {recursive: true, force: true});
  }
});
