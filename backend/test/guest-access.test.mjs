import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const directory = await mkdtemp(join(tmpdir(), 'knovid-guests-'));
process.env.KNOVID_DATA = directory;
process.env.KNOVID_MODE = 'fixture';
process.env.API_TOKEN = 'service-token';
const {createApp} = await import('../src/api.mjs');
const {authenticateAccount} = await import('../src/guest-access.mjs');
const {json, read, projectDir, revisionDir, sceneDir} = await import('../src/common.mjs');
const {createProject} = await import('../src/projects.mjs');
const {creation} = await import('../src/contracts.mjs');
const executor = {async start() {}, async close() {}};
const topic = {input: {type: 'topic', topic: '开普勒定律'}, options: {size: '360p', sceneCount: 32, language: 'zh'}};

async function start(authenticate = async () => null) {
  const app = await createApp({executor, authenticate});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port;
  return {
    request: (path, cookie = '', init = {}) => fetch(base + path, {...init, headers: {
      authorization: 'Bearer service-token', cookie, ...init.headers,
    }}),
    async close() {app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));},
  };
}
const post = body => ({method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
async function guest(app) {
  const response = await app.request('/v1/access');
  assert.equal(response.status, 200);
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly; SameSite=Lax/);
  return header.split(';')[0];
}
async function completed(job) {
  await json(join(revisionDir(job), 'status.json'), {status: 'succeeded'});
  await json(join(revisionDir(job), 'plan.json'), {scenes: [{id: 's1'}]});
  await json(join(sceneDir(job, 's1'), 'program.json'), {paramSchema: {radius: {type: 'number', min: 0, max: 2}}, params: {radius: 1}});
}

try {
  await test('guest quota is persisted and reserved across concurrent API instances', async () => {
    const first = await start();
    const second = await start();
    try {
      const cookie = await guest(first);
      const before = await (await first.request('/v1/access', cookie)).json();
      assert.deepEqual(before.limits, {maxDurationSeconds: 30, maxGenerations: 3, maxRetriesPerProject: 2});
      assert.equal(before.mode, 'guest'); // A service bearer never grants membership.
      const responses = await Promise.all(Array.from({length: 8}, (_, i) => (i % 2 ? first : second).request('/v1/projects', cookie,
        post({...topic, isMember: true, options: {...topic.options, maxDurationSeconds: null}}))));
      assert.equal(responses.filter(response => response.status === 202).length, 3);
      assert.equal(responses.filter(response => response.status === 429).length, 5);
      const jobs = await Promise.all(responses.filter(response => response.status === 202).map(response => response.json()));
      for (const job of jobs) {
        const input = await read(join(projectDir(job.projectId), 'input.json'));
        assert.equal(input.options.sceneCount, 3);
        assert.equal(input.options.maxDurationSeconds, 30);
      }
      const after = await (await second.request('/v1/access', cookie)).json();
      assert.equal(after.usage.generations, 3);
      assert.equal(after.remainingGenerations, 0);
      assert.equal(after.canGenerate, false);
      assert.equal((await second.request('/v1/projects/' + jobs[0].projectId, cookie)).status, 200);
      const outsider = await guest(second);
      assert.deepEqual((await (await second.request('/v1/projects', outsider)).json()).projects, []);
      for (const path of ['/v1/projects/' + jobs[0].projectId, jobs[0].href, jobs[0].href + '/artifacts/video.mp4']) {
        assert.equal((await second.request(path, outsider)).status, 404);
      }
      assert.equal((await second.request(jobs[0].href + '/retry', outsider, {method: 'POST'})).status, 404);
      await first.close();
      const restarted = await start();
      try {assert.equal((await (await restarted.request('/v1/access', cookie)).json()).usage.generations, 3);}
      finally {await restarted.close();}
    } finally {await first.close(); await second.close();}
  });

  await test('edits consume generations, invalid edits refund, and retries have their own cap', async () => {
    const app = await start();
    try {
      const cookie = await guest(app);
      let job = await (await app.request('/v1/projects', cookie, post(topic))).json();
      const edit = body => app.request('/v1/projects/' + job.projectId + '/scenes/s1', cookie, {...post(body), method: 'PATCH'});
      assert.equal((await edit({baseRevisionId: job.revisionId, narration: '短句。'})).status, 409);
      assert.equal((await (await app.request('/v1/access', cookie)).json()).usage.generations, 1);
      await completed(job);
      const long = await edit({baseRevisionId: job.revisionId, narration: '这是很长的一段旁白。'.repeat(5)});
      assert.equal(long.status, 400);
      assert.equal((await long.json()).error.code, 'GUEST_NARRATION_LIMIT');
      assert.equal((await (await app.request('/v1/access', cookie)).json()).usage.generations, 1);
      job = await (await edit({baseRevisionId: job.revisionId, narration: '精简的知识讲解。'})).json();
      await json(join(revisionDir(job), 'status.json'), {status: 'failed', error: {code: 'GUEST_DURATION_LIMIT'}});
      const repairable = await (await app.request('/v1/projects/' + job.projectId, cookie)).json();
      assert.equal(repairable.access.canEdit, true);
      job = await (await edit({baseRevisionId: job.revisionId, params: {radius: 1.2}})).json();
      assert.equal((await (await app.request('/v1/access', cookie)).json()).usage.generations, 3);
      for (let index = 0; index < 2; index++) {
        await json(join(revisionDir(job), 'status.json'), {status: 'failed'});
        const retry = await app.request(job.href + '/retry', cookie, {method: 'POST'});
        assert.equal(retry.status, 202);
        job = await retry.json();
      }
      await json(join(revisionDir(job), 'status.json'), {status: 'failed'});
      const exhausted = await app.request(job.href + '/retry', cookie, {method: 'POST'});
      assert.equal(exhausted.status, 429);
      assert.equal((await exhausted.json()).error.code, 'GUEST_RETRY_LIMIT');
      const state = await (await app.request('/v1/projects/' + job.projectId, cookie)).json();
      assert.equal(state.access.canRetry, false);
      assert.equal(state.access.remainingRetries, 0);
      assert.equal(state.access.remainingGenerations, 0);
      assert.equal(state.access.maxNarrationCharacters, 32);
    } finally {await app.close();}
  });

  await test('verified membership claims only projects bound to the presented guest cookie', async () => {
    const app = await start(async request => request.headers['x-test-member'] ? {id: 'member-a', displayName: 'Member'} : null);
    try {
      const cookie = await guest(app);
      const outsider = await guest(app);
      const own = await (await app.request('/v1/projects', cookie, post(topic))).json();
      const other = await (await app.request('/v1/projects', outsider, post(topic))).json();
      const legacy = await createProject(executor, creation(topic));
      const member = {headers: {'x-test-member': 'true'}};
      const accesses = await Promise.all([app.request('/v1/access', cookie, member), app.request('/v1/access', cookie, member)]);
      for (const response of accesses) assert.equal((await response.json()).mode, 'member');
      assert.equal((await app.request('/v1/projects/' + own.projectId, '', member)).status, 200);
      assert.equal((await app.request('/v1/projects/' + own.projectId, cookie)).status, 404);
      assert.equal((await app.request('/v1/projects/' + other.projectId, cookie, member)).status, 404);
      assert.equal((await app.request('/v1/projects/' + legacy.projectId, cookie, member)).status, 404);
      const listed = (await (await app.request('/v1/projects', '', member)).json()).projects;
      assert.deepEqual(listed.map(project => project.id), [own.projectId]);
      assert.equal(listed[0].owner, undefined);
      assert.equal((await (await app.request('/v1/access', cookie)).json()).usage.generations, 1);
    } finally {await app.close();}
  });

  await test('account verification forwards only the real session and fails closed', async () => {
    const seen = [];
    let status = 200;
    const auth = createServer((request, response) => {
      seen.push({path: request.url, cookie: request.headers.cookie});
      response.writeHead(status, {'content-type': 'application/json'}).end(JSON.stringify({user: {id: 'account-a', status: 'active'}}));
    });
    auth.listen(0, '127.0.0.1');
    await once(auth, 'listening');
    process.env.ACCOUNT_API_ORIGIN = 'http://127.0.0.1:' + auth.address().port;
    const token = 'a'.repeat(43);
    const request = {headers: {cookie: 'knovid_session=' + token + '; knovid_guest=' + 'b'.repeat(64)}};
    try {
      assert.equal((await authenticateAccount(request)).id, 'account-a');
      assert.deepEqual(seen[0], {path: '/api/auth/me', cookie: 'knovid_session=' + token});
      status = 401;
      await assert.rejects(authenticateAccount(request), error => error.code === 'UNAUTHENTICATED');
      status = 503;
      await assert.rejects(authenticateAccount(request), error => error.code === 'ACCOUNT_SERVICE_UNAVAILABLE');
      await assert.rejects(authenticateAccount({headers: {cookie: 'knovid_session=forged'}}), error => error.code === 'UNAUTHENTICATED');
      await assert.rejects(authenticateAccount({headers: {cookie: 'knovid_session=' + token + '; knovid_session=' + token}}), error => error.code === 'UNAUTHENTICATED');
      assert.equal(await authenticateAccount({headers: {cookie: 'knovid_guest=anonymous'}}), null);
    } finally {
      auth.closeAllConnections();
      await new Promise(resolve => auth.close(resolve));
      delete process.env.ACCOUNT_API_ORIGIN;
    }
  });
} finally {
  await rm(directory, {recursive: true, force: true});
}
