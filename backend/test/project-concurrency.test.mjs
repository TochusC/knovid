import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

await test('independent API processes accept only one member edit per base revision without losing accepted versions', {timeout: 15_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knovid-project-lock-'));
  process.env.KNOVID_DATA = directory;
  const {createProject} = await import('../src/projects.mjs');
  const {creation} = await import('../src/contracts.mjs');
  const {json, revisionDir, sceneDir} = await import('../src/common.mjs');
  const apiModule = new URL('../src/api.mjs', import.meta.url).href;
  const worker = `
    import {createApp} from ${JSON.stringify(apiModule)};
    import {once} from 'node:events';
    const executor = {async start() {}, async close() {}};
    const app = await createApp({executor, authenticate: async () => ({id: 'concurrent-member'})});
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    process.send({port: app.server.address().port});
    process.on('message', async message => {
      if (message !== 'close') return;
      app.server.closeAllConnections();
      await new Promise(resolve => app.server.close(resolve));
      process.exit(0);
    });
  `;
  const children = [];
  try {
    const origins = await Promise.all(Array.from({length: 4}, async () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', worker], {
        env: {...process.env, KNOVID_DATA: directory, API_TOKEN: ''}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      let errors = '';
      child.stderr.on('data', buffer => {errors += buffer.toString();});
      const [message] = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(([code]) => {throw new Error('API child exited ' + code + ': ' + errors);}),
      ]);
      return 'http://127.0.0.1:' + message.port;
    }));
    for (let round = 0; round < 3; round++) {
      const job = await createProject({async start() {}}, creation({input: {type: 'topic', topic: '并发修改'}, options: {size: '360p'}}), undefined, 'member:concurrent-member');
      await json(join(revisionDir(job), 'status.json'), {status: 'succeeded'});
      await json(join(revisionDir(job), 'plan.json'), {scenes: [{id: 's1'}]});
      await json(join(sceneDir(job, 's1'), 'program.json'), {paramSchema: {radius: {type: 'number', min: 0, max: 2}}, params: {radius: 1}});
      const responses = await Promise.all(origins.map((origin, index) => fetch(origin + '/v1/projects/' + job.projectId + '/scenes/s1', {
        method: 'PATCH', headers: {'content-type': 'application/json'},
        body: JSON.stringify({baseRevisionId: job.revisionId, params: {radius: (index + 1) / 4}}),
      })));
      assert.deepEqual(responses.map(response => response.status).sort(), [202, 409, 409, 409]);
      for (const response of responses) {
        const result = await response.json();
        if (response.status === 409) assert.equal(result.error.code, 'STALE_REVISION');
        else for (const origin of origins) assert.equal((await fetch(origin + result.href)).status, 200);
      }
      const project = await (await fetch(origins[0] + '/v1/projects/' + job.projectId)).json();
      assert.equal(project.revisionIds.length, 2);
    }
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.send('close');
      await exited;
    }));
    await rm(directory, {recursive: true, force: true});
  }
});
