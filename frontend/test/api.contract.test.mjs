import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

test('frontend adapter follows the actual backend HTTP contract', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'knovid-frontend-api-'));
  process.env.KNOVID_DATA = temporary;
  delete process.env.API_TOKEN;
  const {createApp} = await import('../../backend/src/api.mjs');
  const submitted = [];
  let queueUnavailable = false;
  const executor = {
    async start(job) {
      submitted.push(job);
      if (queueUnavailable) throw Object.assign(new Error('Test queue unavailable'), {code: 'QUEUE_UNAVAILABLE'});
    },
    async close() {},
  };
  const authenticate = async () => ({id: 'frontend-contract-member', displayName: 'Contract member'});
  const {server} = await createApp({executor, authenticate});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const source = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  globalThis.window = globalThis;
  const loadAdapter = async base => {
    const javascript = stripTypeScriptTypes(source.replace('import.meta.env.VITE_API_BASE_URL', JSON.stringify(base)));
    return import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));
  };
  const {api, ApiError} = await loadAdapter(origin);
  const nativeFetch = globalThis.fetch;
  const input = {
    inputType: 'topic', topic: '行星为什么会加速', audience: 'general', durationSeconds: 90,
    style: 'editorial', aspectRatio: '16:9', sceneCount: 2, size: '720p', music: false,
  };
  const json = async (path, value) => {
    await mkdir(join(path, '..'), {recursive: true});
    await writeFile(path, JSON.stringify(value));
  };
  let project;

  t.after(async () => {
    globalThis.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(temporary, {recursive: true, force: true});
  });

  await t.test('health, JSON creation and list return usable frontend projects', async () => {
    assert.equal((await api.getHealth()).status, 'ok');
    project = await api.createProject(input);
    assert.match(project.id, /^[a-f0-9-]{36}$/);
    assert.equal(project.title, input.topic);
    assert.equal(project.status, 'queued');
    assert.equal(project.canRetry, true);
    assert.deepEqual(project.scenes, []);
    assert.equal(submitted.length, 1);
    const stored = JSON.parse(await readFile(join(temporary, 'projects', project.id, 'input.json')));
    assert.equal(stored.options.width, 1280);
    assert.equal(stored.options.sceneCount, 2);
    assert.equal(stored.options.music, false);
    const list = await api.listProjects();
    assert.equal(list[0].id, project.id);
    assert.equal(list[0].title, input.topic);
  });

  await t.test('raw PDF upload preserves filename and supported settings', async () => {
    const pdf = new File(['%PDF-1.7\nfixture\n%%EOF'], '中文论文.pdf', {type: 'application/pdf'});
    const paper = await api.createProject({...input, inputType: 'paper', topic: undefined, paperFile: pdf, music: true, size: '360p'});
    assert.equal(paper.input.type, 'paper');
    assert.equal(paper.input.fileName, '中文论文.pdf');
    const base = join(temporary, 'projects', paper.id);
    assert.equal((await readFile(join(base, 'paper.pdf'))).toString(), await pdf.text());
    assert.equal(JSON.parse(await readFile(join(base, 'input.json'))).options.width, 640);
    const silentPaper = await api.createProject({...input, paperFile: pdf, music: false});
    const silentSettings = JSON.parse(await readFile(join(temporary, 'projects', silentPaper.id, 'input.json')));
    assert.equal(silentSettings.options.music, false);
  });

  await t.test('paper links use the backend paper-url contract', async () => {
    const paper = await api.createProject({...input, inputType: 'paper', topic: undefined, paperUrl: 'https://arxiv.org/abs/1706.03762'});
    assert.equal(paper.input.paperUrl, 'https://arxiv.org/pdf/1706.03762');
  });

  await t.test('paid providers, saved styles and optional narration are serialized for each creation path', async () => {
    const {api: modelApi} = await loadAdapter(origin + '/paid-provider-test');
    const pricing = {id: 'deepseek', creditsPerScene: 1, creditsPerDurationUnit: 1, durationUnitSeconds: 30, maxSceneSeconds: 60};
    const memberAccess = {
      mode: 'member', canGenerate: true, remainingGenerations: null, usage: {generations: 0},
      limits: {maxDurationSeconds: null, maxGenerations: null},
      modelProviders: [pricing, {...pricing, id: 'openrouter', durationUnitSeconds: 0}, {...pricing, id: 'unknown'}],
    };
    const projectId = '11111111-1111-4111-8111-111111111111';
    const revisionId = '22222222-2222-4222-8222-222222222222';
    const preset = {id: revisionId, style: 'Purple and blue', summary: 'Motion graphics'};
    const requests = [];
    let access = memberAccess;
    let provider;
    globalThis.fetch = async (url, options) => {
      const route = new URL(url);
      if (route.pathname.endsWith('/v1/access')) return Response.json(access);
      if (route.pathname.endsWith('/v1/rixin/styles')) return Response.json({presets: [preset, {...preset, id: 'default'}]});
      if (options.method === 'POST') {
        if (options.headers.get('content-type') === 'application/pdf') {
          provider = route.searchParams.get('modelProvider') || undefined;
          requests.push(['pdf', provider, route.searchParams.get('stylePresetId'), route.searchParams.get('narration')]);
        } else {
          const payload = JSON.parse(options.body);
          provider = payload.options.modelProvider;
          requests.push([payload.input.type, provider, payload.options.stylePresetId, payload.options.narration]);
        }
        return Response.json({projectId, revisionId, accepted: true}, {status: 202});
      }
      return Response.json({
        id: projectId, createdAt: new Date().toISOString(), latestRevisionId: revisionId, revisionIds: [revisionId],
        input: {type: 'topic', title: 'Test'},
        options: {language: 'zh', sceneCount: 3, modelProvider: provider},
        latest: {status: 'queued', stage: 'queued', scenes: [], evidence: [], artifacts: {}},
      });
    };
    try {
      assert.deepEqual((await modelApi.getAccess()).modelProviders, [pricing]);
      assert.deepEqual(await modelApi.listStylePresets(), [preset]);
      const paid = await modelApi.createProject({...input, modelProvider: 'deepseek', stylePresetId: 'default'});
      assert.equal(paid.settings.modelProvider, 'deepseek');
      await modelApi.createProject({
        ...input, inputType: 'paper', paperUrl: 'https://arxiv.org/abs/1706.03762', modelProvider: 'openrouter',
        stylePresetId: 'auto', narration: false,
      });
      await modelApi.createProject({
        ...input, inputType: 'paper', paperFile: new File(['%PDF-1.7'], 'paper.pdf'), modelProvider: 'openrouter',
        stylePresetId: preset.id, narration: false,
      });
      await modelApi.createProject({...input, modelProvider: 'standard'});
      assert.deepEqual(requests, [
        ['topic', 'deepseek', 'default', undefined], ['paper-url', 'openrouter', 'auto', false],
        ['pdf', 'openrouter', preset.id, 'false'], ['topic', undefined, undefined, undefined],
      ]);
      access = {...memberAccess, mode: 'guest'};
      modelApi.resetIdentity();
      assert.deepEqual((await modelApi.getAccess()).modelProviders, []);
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });

  await t.test('input validation and server failures use actionable Chinese messages', async () => {
    await assert.rejects(api.createProject({...input, topic: '长'.repeat(301)}), error => error.code === 'INVALID_INPUT' && error.message.includes('300') && !error.message.includes('input.topic'));
    await assert.rejects(api.createProject({...input, inputType: 'paper', paperUrl: 'https://example.com/paper.pdf'}), error => error.message.includes('上传 PDF') && !error.message.includes('hosts:'));
    const english = await api.createProject({...input, topic: 'Kepler laws', language: 'en'});
    assert.equal(english.settings.language, 'en');
    globalThis.fetch = async () => Response.json({error: {code: 'UNEXPECTED', message: 'Internal server exception'}}, {status: 500});
    try {
      await assert.rejects(api.getHealth(), error => error.status === 500 && error.message === '制作服务暂时不可用，请稍后重试。');
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });

  await t.test('completed scene, evidence, schema and versioned downloads normalize correctly', async () => {
    const dir = join(temporary, 'projects', project.id, 'revisions', project.revisionId);
    await json(join(dir, 'plan.json'), {
      title: '看懂行星轨道',
      scenes: ['s1', 's2'].map(id => ({id, title: `轨道 ${id}`, visual: '展示椭圆轨道', evidenceIds: ['e1']})),
    });
    await json(join(dir, 'evidence.json'), {evidence: [{id: 'e1', title: '原始资料', quote: '相同时间扫过相同面积', page: 3}]});
    for (const [index, id] of ['s1', 's2'].entries()) {
      const sceneDir = join(dir, 'scenes', id);
      await json(join(sceneDir, 'program.json'), {params: {eccentricity: 0.5}, paramSchema: {eccentricity: {type: 'number', label: '偏心率', min: 0.15, max: 0.75, default: 0.5}}});
      await json(join(sceneDir, 'script.json'), {segments: [{text: '行星沿椭圆轨道运动。'}]});
      await json(join(sceneDir, 'timing.json'), {durationFrames: index === 0 ? 50 : 75, fps: 25});
      await writeFile(join(sceneDir, 'frame.png'), 'fixture-frame');
      await writeFile(join(sceneDir, 'preview.mp4'), 'fixture-preview');
    }
    const queuedAt = new Date(Date.now() - 90_000).toISOString();
    const finishedAt = new Date(Date.parse(queuedAt) + 80_000).toISOString();
    await json(join(dir, 'status.json'), {status: 'running', stage: 'assembly', queuedAt, updatedAt: new Date().toISOString()});
    const inProgress = await api.getProject(project.id);
    assert.equal(inProgress.status, 'rendering');
    assert.equal(inProgress.videoUrl, undefined);
    assert.ok(inProgress.productionElapsedSeconds >= 90);
    const response = await nativeFetch(inProgress.scenes[0].videoUrl, {headers: {Range: 'bytes=0-6'}});
    assert.equal(response.status, 206);
    assert.equal(await response.text(), 'fixture');

    await writeFile(join(dir, 'video.mp4'), 'fixture-video');
    await writeFile(join(dir, 'project.zip'), 'fixture-project');
    await json(join(dir, 'status.json'), {status: 'succeeded', stage: 'complete', queuedAt, finishedAt, updatedAt: finishedAt});
    project = await api.getProject(project.id);
    assert.equal(project.status, 'ready');
    assert.equal(project.durationSeconds, 5);
    assert.equal(project.productionElapsedSeconds, 80);
    assert.equal(project.productionTimingEstimated, false);
    assert.equal(project.canEdit, true);
    assert.equal(project.progress, 100);
    assert.equal(project.sources[0].excerpt, '相同时间扫过相同面积');
    assert.equal(project.scenes[0].parameterSchema.eccentricity.label, '偏心率');
    assert.equal(project.scenes[0].durationSeconds, 2);
    await assert.rejects(api.updateScene(project.id, 's1', {narration: '长'.repeat(321), baseRevisionId: project.revisionId}), error => error.code === 'INVALID_INPUT' && error.message.includes('320'));
    const exported = await api.exportProject(project.id);
    assert.equal(exported.url, `${origin}/v1/projects/${project.id}/revisions/${project.revisionId}/artifacts/video.mp4`);
    assert.equal(await (await nativeFetch(exported.url)).text(), 'fixture-video');
    const archive = await api.exportProject(project.id, 'project');
    assert.equal(await (await nativeFetch(archive.url)).text(), 'fixture-project');
  });

  await t.test('PATCH starts a new revision, rejects stale edits and retries without duplicate projects', async () => {
    const previousRevision = project.revisionId;
    project = await api.updateScene(project.id, 's1', {narration: '这是修改后的讲解。', parameters: {eccentricity: 0.4}, baseRevisionId: previousRevision});
    assert.notEqual(project.revisionId, previousRevision);
    assert.equal(project.status, 'queued');
    assert.equal(project.canEdit, false);
    assert.equal(project.videoUrl, undefined);
    await assert.rejects(api.updateScene(project.id, 's1', {narration: '过期修改', baseRevisionId: previousRevision}), error => error instanceof ApiError && error.code === 'STALE_REVISION' && error.status === 409);
    const retried = await api.renderProject(project.id);
    assert.equal(retried.revisionId, project.revisionId);
    await assert.rejects(api.exportProject(project.id), error => error.code === 'ARTIFACT_NOT_READY');
  });

  await t.test('503 dispatch failure preserves the saved project for a safe retry', async () => {
    queueUnavailable = true;
    const queued = await api.createProject({...input, topic: '队列故障测试'});
    assert.equal(queued.status, 'queued');
    assert.equal(queued.canRetry, true);
    assert.match(queued.error, /项目已保存/);
    queueUnavailable = false;
    const resumed = await api.renderProject(queued.id);
    assert.equal(resumed.id, queued.id);
    assert.equal(resumed.error, undefined);
  });

  await t.test('a failed edit can be repaired using its successful source revision', async () => {
    const failedRevisionId = project.revisionId;
    const dir = join(temporary, 'projects', project.id, 'revisions', failedRevisionId);
    await json(join(dir, 'status.json'), {status: 'failed', stage: 'failed', error: {code: 'TASK_TIMEOUT', message: 'Timed out'}, updatedAt: new Date().toISOString()});
    const failed = await api.getProject(project.id);
    assert.equal(failed.canEdit, true);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.revisionId, failedRevisionId);
    assert.match(failed.error, /超时/);
    assert.equal(failed.scenes.length, 2);
    assert.equal(failed.scenes[0].narration, '行星沿椭圆轨道运动。');
    assert.equal(failed.scenes[0].parameterSchema.eccentricity.label, '偏心率');
    assert.notEqual(failed.editingSourceRevisionId, failedRevisionId);
    assert.equal(failed.videoUrl, undefined);
    assert.equal(failed.downloadUrl, undefined);
    assert.equal(failed.scenes[0].videoUrl, undefined);
    assert.equal(failed.scenes[0].previewUrl, undefined);
    const repaired = await api.updateScene(project.id, 's1', {baseRevisionId: failedRevisionId, narration: '修复后的讲解。'});
    assert.notEqual(repaired.revisionId, failedRevisionId);
    assert.equal(repaired.status, 'queued');
    assert.equal(repaired.canEdit, false);
  });

  await t.test('accepted mutation followed by read failure exposes its persisted identity', async () => {
    let acceptedId;
    globalThis.fetch = async (url, options) => {
      if (acceptedId && String(url).endsWith(`/v1/projects/${acceptedId}`)) throw new TypeError('Simulated connection interruption');
      const response = await nativeFetch(url, options);
      if (options?.method === 'POST') acceptedId = (await response.clone().json()).projectId;
      return response;
    };
    try {
      await assert.rejects(api.createProject({...input, topic: '请求已经保存'}), error => error.code === 'ACCEPTED_STATUS_UNAVAILABLE' && error.acceptedOperation.projectId === acceptedId);
    } finally {
      globalThis.fetch = nativeFetch;
    }
    assert.equal((await api.getProject(acceptedId)).title, '请求已经保存');
  });

  await t.test('backend bearer authentication is distinct from user login', async () => {
    process.env.API_TOKEN = 'contract-test-token';
    const secured = await createApp({executor, authenticate});
    delete process.env.API_TOKEN;
    await new Promise(resolve => secured.server.listen(0, '127.0.0.1', resolve));
    try {
      const securedAdapter = await loadAdapter(`http://127.0.0.1:${secured.server.address().port}`);
      await assert.rejects(securedAdapter.api.listProjects(), error => error.status === 401 && error.code === 'API_AUTH_REQUIRED');
    } finally {
      secured.server.closeAllConnections();
      await new Promise(resolve => secured.server.close(resolve));
    }
  });

  await t.test('visitor cookies and quota persist, and login claims projects exclusively', async () => {
    let memberIdentity = null;
    const guestApp = await createApp({executor, authenticate: async () => memberIdentity});
    await new Promise(resolve => guestApp.server.listen(0, '127.0.0.1', resolve));
    const guestOrigin = `http://127.0.0.1:${guestApp.server.address().port}`;
    const {api: guestApi} = await loadAdapter(guestOrigin);
    let guestCookie = '';
    let cookieAttributes = '';
    globalThis.fetch = async (url, options = {}) => {
      const headers = new Headers(options.headers);
      if (String(url).startsWith(guestOrigin) && guestCookie) headers.set('cookie', guestCookie);
      const response = await nativeFetch(url, {...options, headers});
      const setCookie = response.headers.get('set-cookie');
      if (setCookie?.startsWith('knovid_guest=')) {
        guestCookie = setCookie.split(';')[0];
        cookieAttributes = setCookie;
      }
      return response;
    };
    try {
      const access = await guestApi.getAccess();
      assert.equal(access.mode, 'guest');
      assert.equal(access.limits.maxDurationSeconds, 30);
      assert.equal(access.limits.maxGenerations, 3);
      assert.equal(access.remainingGenerations, 3);
      assert.equal(access.canGenerate, true);
      assert.match(cookieAttributes, /HttpOnly/);
      assert.match(cookieAttributes, /SameSite=Lax/);

      const guestProject = await guestApi.createProject({...input, topic: '访客轨道讲解'});
      assert.equal(guestProject.sceneCount, 3);
      assert.equal(guestProject.access.maxDurationSeconds, 30);
      const afterCreate = await guestApi.getAccess();
      assert.equal(afterCreate.usage.generations, 1);
      assert.equal(afterCreate.remainingGenerations, 2);
      assert.equal((await guestApi.listProjects()).length, 1);
      assert.equal((await api.listProjects()).some(item => item.id === guestProject.id), false);
      assert.equal((await nativeFetch(`${guestOrigin}/v1/projects/${guestProject.id}`)).status, 404);

      const dir = join(temporary, 'projects', guestProject.id, 'revisions', guestProject.revisionId);
      const scenes = ['s1', 's2', 's3'].map(id => ({id, title: id, visual: '轨道', evidenceIds: []}));
      await json(join(dir, 'plan.json'), {title: '访客轨道讲解', scenes});
      for (const scene of scenes) {
        const folder = join(dir, 'scenes', scene.id);
        await json(join(folder, 'program.json'), {params: {eccentricity: 0.4}, paramSchema: {eccentricity: {type: 'number', label: '偏心率', min: 0.15, max: 0.75, default: 0.4}}});
        await json(join(folder, 'script.json'), {segments: [{text: '行星沿椭圆轨道运动。'}]});
        await json(join(folder, 'timing.json'), {durationFrames: 125, fps: 25});
      }
      await writeFile(join(dir, 'video.mp4'), 'guest-video');
      await json(join(dir, 'status.json'), {status: 'succeeded', stage: 'complete', updatedAt: new Date().toISOString()});
      const complete = await guestApi.getProject(guestProject.id);
      assert.equal(complete.canEdit, true);
      assert.equal((await nativeFetch(complete.videoUrl)).status, 404);
      assert.equal(await (await globalThis.fetch(complete.videoUrl)).text(), 'guest-video');

      const edited = await guestApi.updateScene(guestProject.id, 's1', {baseRevisionId: guestProject.revisionId, narration: '修改后的知识讲解。'});
      assert.equal((await guestApi.getAccess()).usage.generations, 2);
      assert.equal(edited.canEdit, false);
      await assert.rejects(guestApi.updateScene(guestProject.id, 's1', {baseRevisionId: guestProject.revisionId, narration: '过期版本修改。'}), error => error.code === 'STALE_REVISION');
      assert.equal((await guestApi.getAccess()).usage.generations, 2);
      const firstRetry = await guestApi.renderProject(edited.id);
      assert.equal(firstRetry.access.remainingRetries, 1);
      assert.equal((await guestApi.getAccess()).usage.generations, 2);
      const secondRetry = await guestApi.renderProject(edited.id);
      assert.equal(secondRetry.access.remainingRetries, 0);
      await assert.rejects(guestApi.renderProject(edited.id), error => error.code === 'GUEST_RETRY_LIMIT' && error.message.includes('登录'));

      const third = await guestApi.createProject({...input, topic: '第三次生成'});
      const exhausted = await guestApi.getAccess();
      assert.equal(exhausted.remainingGenerations, 0);
      assert.equal(exhausted.canGenerate, false);
      await assert.rejects(guestApi.createProject({...input, topic: '第四次生成'}), error => error.code === 'GUEST_LIMIT_REACHED' && error.message.includes('登录'));
      const retryAfterExhaustion = await guestApi.renderProject(third.id);
      assert.equal(retryAfterExhaustion.access.remainingGenerations, 0);
      assert.equal(retryAfterExhaustion.access.remainingRetries, 1);
      assert.equal((await guestApi.getAccess()).usage.generations, 3);

      const memberAccess = await api.getAccess();
      assert.equal(memberAccess.mode, 'member');
      assert.equal(memberAccess.remainingGenerations, null);
      assert.equal(memberAccess.limits.maxDurationSeconds, null);

      memberIdentity = {id: 'guest-project-claimant', displayName: 'Claimed member'};
      guestApi.resetIdentity();
      assert.equal((await guestApi.getAccess()).mode, 'member');
      const claimed = await guestApi.getProject(guestProject.id);
      assert.equal(claimed.access.remainingGenerations, null);
      assert.equal(claimed.access.maxDurationSeconds, 30);
      assert.equal(claimed.access.maxNarrationCharacters, 32);
      assert.equal((await guestApi.listProjects()).length, 2);
      assert.equal(await (await globalThis.fetch(complete.videoUrl)).text(), 'guest-video');

      memberIdentity = null;
      guestApi.resetIdentity();
      assert.equal((await guestApi.getAccess()).mode, 'guest');
      assert.deepEqual(await guestApi.listProjects(), []);
      await assert.rejects(guestApi.getProject(guestProject.id), error => error.status === 404);
      assert.equal((await globalThis.fetch(complete.videoUrl)).status, 404);

      memberIdentity = {id: 'different-member', displayName: 'Another member'};
      guestApi.resetIdentity();
      assert.equal((await guestApi.getAccess()).mode, 'member');
      assert.deepEqual(await guestApi.listProjects(), []);
      await assert.rejects(guestApi.getProject(guestProject.id), error => error.status === 404);
    } finally {
      globalThis.fetch = nativeFetch;
      guestApp.server.closeAllConnections();
      await new Promise(resolve => guestApp.server.close(resolve));
    }
  });

  await t.test('first concurrent access and project requests share one guest cookie even when one caller aborts', async () => {
    const guestApp = await createApp({executor, authenticate: async () => null});
    await new Promise(resolve => guestApp.server.listen(0, '127.0.0.1', resolve));
    const guestOrigin = `http://127.0.0.1:${guestApp.server.address().port}`;
    const {api: freshApi} = await loadAdapter(guestOrigin);
    let releaseAccess;
    const accessGate = new Promise(resolve => { releaseAccess = resolve; });
    let accessRequests = 0;
    let issuedCookies = 0;
    let guestCookie = '';
    const projectCookies = [];
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith('/v1/access')) {
        accessRequests++;
        if (accessRequests === 1) await accessGate;
      }
      const headers = new Headers(options.headers);
      if (guestCookie) headers.set('cookie', guestCookie);
      if (String(url).includes('/v1/projects')) projectCookies.push(headers.get('cookie'));
      const response = await nativeFetch(url, {...options, headers});
      const setCookie = response.headers.get('set-cookie');
      if (setCookie?.startsWith('knovid_guest=')) {
        issuedCookies++;
        guestCookie = setCookie.split(';')[0];
      }
      return response;
    };
    try {
      const controller = new AbortController();
      const aborted = freshApi.getAccess(controller.signal);
      const rejected = assert.rejects(aborted, error => error.name === 'AbortError');
      const projects = freshApi.listProjects();
      controller.abort();
      await rejected;
      releaseAccess();
      assert.deepEqual(await projects, []);
      assert.equal(accessRequests, 1);
      assert.equal(issuedCookies, 1);
      assert.equal(projectCookies[0], guestCookie);
      assert.equal((await freshApi.getAccess()).remainingGenerations, 3);
      assert.equal(accessRequests, 2);
      assert.equal(issuedCookies, 1);
    } finally {
      releaseAccess();
      globalThis.fetch = nativeFetch;
      guestApp.server.closeAllConnections();
      await new Promise(resolve => guestApp.server.close(resolve));
    }
  });

  await t.test('identity reset prevents an old response from initializing the new account', async () => {
    const {api: changingApi} = await loadAdapter(`${origin}/identity-epoch-test`);
    let releaseOld;
    let releaseCurrent;
    const oldGate = new Promise(resolve => { releaseOld = resolve; });
    const currentGate = new Promise(resolve => { releaseCurrent = resolve; });
    let accessRequests = 0;
    const guestAccess = {mode: 'guest', limits: {maxDurationSeconds: 30, maxGenerations: 3}, usage: {generations: 0}, remainingGenerations: 3, canGenerate: true};
    const memberAccess = {mode: 'member', limits: {maxDurationSeconds: null, maxGenerations: null}, usage: {generations: 0}, remainingGenerations: null, canGenerate: true};
    // Deliberately return a late response even after its fetch signal is aborted.
    globalThis.fetch = async url => {
      if (!String(url).endsWith('/v1/access')) return Response.json({projects: []});
      const call = ++accessRequests;
      await (call === 1 ? oldGate : currentGate);
      return Response.json(call === 1 ? guestAccess : memberAccess);
    };
    try {
      const oldAccess = changingApi.getAccess();
      const waitingProjects = changingApi.listProjects();
      changingApi.resetIdentity();
      const currentAccess = changingApi.getAccess();
      releaseOld();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(accessRequests, 2);
      releaseCurrent();
      assert.equal((await currentAccess).mode, 'member');
      assert.equal((await oldAccess).mode, 'member');
      assert.deepEqual(await waitingProjects, []);
    } finally {
      releaseOld();
      releaseCurrent();
      globalThis.fetch = nativeFetch;
    }
  });

  await t.test('unavailable or malformed access never invents a balance', async () => {
    globalThis.fetch = async () => Response.json({mode: 'guest'});
    try {
      await assert.rejects(api.getAccess(), error => error.code === 'INVALID_ACCESS_RESPONSE');
      globalThis.fetch = async () => { throw new TypeError('Offline'); };
      await assert.rejects(api.getAccess(), error => error.code === 'NETWORK_ERROR');
      globalThis.fetch = async () => Response.json({error: {code: 'GUEST_DURATION_LIMIT', message: 'Duration exceeded'}}, {status: 422});
      await assert.rejects(api.getAccess(), error => error.code === 'GUEST_DURATION_LIMIT' && error.message.includes('30 秒'));
      globalThis.fetch = async () => Response.json({error: {code: 'ACCOUNT_SERVICE_UNAVAILABLE', message: 'Unavailable'}}, {status: 503});
      await assert.rejects(api.getAccess(), error => error.code === 'ACCOUNT_SERVICE_UNAVAILABLE' && error.message.includes('账号状态'));
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });
});
