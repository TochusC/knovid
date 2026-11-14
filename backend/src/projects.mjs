import {randomUUID} from 'node:crypto';
import {mkdir, readdir, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {Fault, atomic, json, maybe, projectDir, read, revisionDir, root, sceneDir, share, sleep, UUID} from './common.mjs';
import {patchScene} from './contracts.mjs';
import {integerEnv} from './limits.mjs';
import {soundSettings} from './sound.mjs';
import {narrationBudget} from './guest-limits.mjs';
import {productionQuote} from './production-credit.mjs';
import {unavailableTrace} from './workflow-trace.mjs';

const uuid = new RegExp('^' + UUID + '$');
const metaFile = id => join(projectDir(id), 'project.json');
const settingsFile = id => join(projectDir(id), 'input.json');
const requestFile = job => join(revisionDir(job), 'request.json');
const statusFile = job => join(revisionDir(job), 'status.json');
const active = status => ['queued', 'running'].includes(status);
const gone = () => new Fault('NOT_FOUND', 'Project or revision does not exist', {status: 404});
const optional = async file => {
  try {
    return await read(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
};

export async function metadata(projectId) {
  if (!uuid.test(projectId)) throw gone();
  const project = await optional(metaFile(projectId));
  if (!project) throw gone();
  return project;
}

async function checkedRevision(projectId, revisionId) {
  const project = await metadata(projectId);
  if (!uuid.test(revisionId) || !project.revisionIds.includes(revisionId)) throw gone();
  return {projectId, revisionId};
}

export async function revisionTrace(executor, projectId, revisionId) {
  const job = await checkedRevision(projectId, revisionId);
  return executor.trace ? executor.trace(job) : unavailableTrace();
}

const origin = ({projectId, revisionId}) => '/v1/projects/' + projectId + '/revisions/' + revisionId;

const fileNames = new Set([
  'manifest.json', 'evidence.json', 'figures.json', 'plan.json', 'voice.json', 'subtitles.vtt', 'video.mp4', 'project.zip',
  'input.pdf', 'audio-credits.json',
]);
const sceneFiles = new Set(['script.json', 'program.json', 'review.json', 'timing.json', 'scene.mjs', 'frame.png', 'preview.mp4', 'audio.wav']);

export async function artifact(projectId, revisionId, name, scene) {
  const job = await checkedRevision(projectId, revisionId);
  if (!scene && ['video.mp4', 'project.zip'].includes(name)) {
    const request = await read(requestFile(job));
    if (request.job?.billing && (await read(statusFile(job))).status !== 'succeeded') {
      throw new Fault('ARTIFACT_NOT_READY', 'The paid revision has not finished', {status: 404});
    }
  }
  let file;
  if (scene) {
    if (!sceneFiles.has(name)) throw gone();
    file = join(sceneDir(job, scene), name);
  } else {
    if (!fileNames.has(name) && !/^paper-page-\d{1,2}\.png$/.test(name)) throw gone();
    file = name === 'input.pdf' ? join(projectDir(projectId), 'paper.pdf') : join(revisionDir(job), name);
  }
  if (!(await maybe(file))) throw new Fault('ARTIFACT_NOT_READY', 'Artifact is not available', {status: 404});
  return file;
}

export async function revision(projectId, revisionId) {
  const job = await checkedRevision(projectId, revisionId);
  const dir = revisionDir(job);
  const [status, request, plan, evidence, figures] = await Promise.all([
    read(statusFile(job)), read(requestFile(job)), optional(join(dir, 'plan.json')),
    optional(join(dir, 'evidence.json')), optional(join(dir, 'figures.json')),
  ]);
  const timing = await revisionTiming(job, status);
  const prefix = origin(job);
  const names = [...fileNames, ...new Set((figures || []).map(figure => figure.artifact).filter(Boolean))]
    .filter(name => !request.job?.billing || status.status === 'succeeded' || !['video.mp4', 'project.zip'].includes(name));
  const artifacts = Object.fromEntries((await Promise.all(names.map(async name => {
    const file = name === 'input.pdf' ? join(projectDir(projectId), 'paper.pdf') : join(dir, name);
    return await maybe(file) ? [name, prefix + '/artifacts/' + name] : null;
  }))).filter(Boolean));
  const scenes = await Promise.all((plan?.scenes || []).map(async scene => {
    const folder = sceneDir(job, scene.id);
    const [program, script, timing, review] = await Promise.all([
      optional(join(folder, 'program.json')), optional(join(folder, 'script.json')),
      optional(join(folder, 'timing.json')), optional(join(folder, 'review.json')),
    ]);
    const assets = Object.fromEntries((await Promise.all([...sceneFiles].map(async name => await maybe(join(folder, name)) ?
      [name, prefix + '/scenes/' + scene.id + '/artifacts/' + name] : null))).filter(Boolean));
    return {
      ...scene, visual: script?.visual ?? scene.visual,
      status: assets['preview.mp4'] ? 'ready' : timing && program ? 'rendering' : 'preparing',
      paramSchema: program?.paramSchema, params: program?.params, narration: script?.segments.map(segment => segment.text).join(' '),
      issues: review?.issues, durationFrames: timing?.durationFrames, artifacts: assets,
    };
  }));
  return {...job, ...status, ...timing, sourceRevisionId: request.sourceRevisionId, changedScene: request.changedScene,
    title: plan?.title, evidence: evidence?.evidence || [], figures: figures || [], scenes, artifacts};
}

async function revisionTiming(job, status) {
  const inProgress = active(status.status);
  const finishedAt = inProgress ? undefined : status.finishedAt ?? status.updatedAt;
  const end = inProgress ? Date.now() : Date.parse(finishedAt);
  const recordedQueuedAt = status.queuedAt ?? (status.status === 'queued' ? status.updatedAt : undefined);
  let queuedAt = recordedQueuedAt;
  if (!queuedAt) {
    // Older revisions have an immutable request file but no recorded submission timestamp.
    const {mtime} = await stat(requestFile(job));
    if (mtime.getTime() > 0 && mtime.getTime() <= end) queuedAt = mtime.toISOString();
  }
  const start = Date.parse(queuedAt);
  const elapsedSeconds = start <= end ? Math.floor((end - start) / 1000) : undefined;
  return {queuedAt, finishedAt, elapsedSeconds, timingEstimated: !recordedQueuedAt && elapsedSeconds !== undefined};
}

export async function getProject(projectId) {
  const {id, createdAt, latestRevisionId, revisionIds} = await metadata(projectId);
  const {input, options} = await read(settingsFile(id));
  const latest = await revision(id, latestRevisionId);
  const {music, sound} = await read(requestFile({projectId: id, revisionId: latestRevisionId}));
  return {id, createdAt, input: {type: input.type, title: input.title, url: input.url}, options: {...options, music: music ?? options.music, ...sound},
    latestRevisionId, revisionIds, latest};
}

export async function listProjects() {
  const base = join(root, 'projects');
  await mkdir(base, {recursive: true});
  const ids = (await readdir(base)).filter(id => uuid.test(id));
  const projects = (await Promise.all(ids.map(id => optional(metaFile(id))))).filter(Boolean);
  return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function stageJob(project, request, modelProvider, billing) {
  const job = {projectId: project.id, revisionId: randomUUID(), edit: Boolean(request.sourceRevisionId),
    chunkFrames: integerEnv('RENDER_CHUNK_FRAMES', 200, 10, 1500), ...(modelProvider && {modelProvider}), ...(billing && {billing})};
  const dir = revisionDir(job);
  const queuedAt = new Date().toISOString();
  await mkdir(dir, {recursive: true});
  try {
    await json(requestFile(job), {...request, job});
    await json(statusFile(job), {status: 'queued', stage: 'queued', error: null, queuedAt, updatedAt: queuedAt});
    await json(metaFile(project.id), {...project, latestRevisionId: job.revisionId, revisionIds: [...project.revisionIds, job.revisionId]});
  } catch (error) {
    await rm(dir, {recursive: true, force: true});
    throw error;
  }
  return job;
}

async function submit(executor, job) {
  const {projectId, revisionId} = job;
  try {
    await executor.start(job);
  } catch (error) {
    if (error.code !== 'QUEUE_UNAVAILABLE') throw error;
    return {projectId, revisionId, accepted: false, queueError: error.message};
  }
  return {projectId, revisionId, accepted: true};
}

const pending = new Map();

async function serialize(projectId, operation) {
  const previous = pending.get(projectId);
  const next = Promise.resolve(previous).catch(() => {}).then(async () => {
    const folder = join(root, 'locks', 'projects');
    const lock = join(folder, projectId);
    await mkdir(folder, {recursive: true});
    const deadline = Date.now() + 12000;
    while (true) {
      try { await mkdir(lock); break; } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const info = await stat(lock).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 120000) await rm(lock, {recursive: true, force: true});
        if (Date.now() >= deadline) throw new Fault('PROJECT_BUSY', 'Another project change is being saved, please retry shortly', {status: 409});
        await sleep(25);
      }
    }
    try { return await operation(); } finally { await rm(lock, {recursive: true, force: true}); }
  });
  pending.set(projectId, next);
  try {
    return await next;
  } finally {
    if (pending.get(projectId) === next) pending.delete(projectId);
  }
}

export {serialize as withProjectLock};

export async function createProject(executor, payload, pdf, owner) {
  const {modelProvider, sceneCount} = payload.options;
  const billing = await productionQuote(owner, modelProvider, sceneCount);
  const id = randomUUID();
  const project = {id, createdAt: new Date().toISOString(), revisionIds: [], ...(owner ? {owner} : {})};
  await json(settingsFile(id), payload);
  if (pdf) await atomic(join(projectDir(id), 'paper.pdf'), pdf);
  return submit(executor, await stageJob(project, {}, modelProvider, billing));
}

async function editable(projectId, baseRevisionId) {
  const project = await metadata(projectId);
  if (baseRevisionId !== project.latestRevisionId) {
    throw new Fault('STALE_REVISION', 'Use the current latestRevisionId', {status: 409});
  }
  let source = {projectId, revisionId: project.latestRevisionId};
  const {status} = await read(statusFile(source));
  if (status === 'failed' || status === 'cancelled') {
    const {sourceRevisionId} = await read(requestFile(source));
    if (sourceRevisionId) source = {projectId, revisionId: sourceRevisionId};
  }
  if ((await read(statusFile(source))).status !== 'succeeded') {
    throw new Fault('REVISION_NOT_READY', 'A successful revision is needed before editing', {status: 409});
  }
  return {project, source, sourceRequest: await read(requestFile(source))};
}

export function editScene(executor, projectId, scene, body) {
  return serialize(projectId, async () => {
    const {project, source, sourceRequest} = await editable(projectId, body?.baseRevisionId);
    const [program, settings] = await Promise.all([
      optional(join(sceneDir(source, scene), 'program.json')), read(settingsFile(projectId)),
    ]);
    if (!program) throw gone();
    const patch = patchScene(body, program.paramSchema, settings.options.language);
    const budget = narrationBudget(settings.options);
    if (budget && patch.narration?.length > budget) {
      throw new Fault('GUEST_NARRATION_LIMIT', '访客短片每段讲解最多 ' + budget + ' 个字符，请精简后保存。', {status: 400});
    }
    const {modelProvider, sceneCount} = settings.options;
    const billing = patch.narration ? await productionQuote(project.owner, modelProvider, sceneCount) : undefined;
    return submit(executor, await stageJob(project, {sourceRevisionId: source.revisionId, changedScene: scene, patch,
      music: sourceRequest.music, sound: sourceRequest.sound}, modelProvider, billing));
  });
}

export function editProject(executor, projectId, body) {
  return serialize(projectId, async () => {
    const {project, source, sourceRequest} = await editable(projectId, body?.baseRevisionId);
    const {sceneOrder, music, sound: requestedSound} = body;
    const {options} = await read(settingsFile(projectId));
    const changes = requestedSound === undefined ? {} : soundSettings(requestedSound, options.language, true);
    const sound = {...sourceRequest.sound, ...changes};
    const previousVoice = sourceRequest.sound?.voiceStyle ?? options.voiceStyle ?? 'warm';
    const voiceChanged = sound.voiceStyle !== undefined && sound.voiceStyle !== previousVoice;
    if (sceneOrder !== undefined) {
      const {scenes} = await read(join(revisionDir(source), 'plan.json'));
      if (!Array.isArray(sceneOrder) || sceneOrder.length !== scenes.length ||
        new Set(sceneOrder).size !== scenes.length || !scenes.every(scene => sceneOrder.includes(scene.id))) {
        throw new Fault('INVALID_INPUT', 'sceneOrder must contain every existing scene ID exactly once', {status: 400});
      }
    }
    if ((music !== undefined && typeof music !== 'boolean') ||
      (sceneOrder === undefined && music === undefined && Object.keys(changes).length === 0)) {
      throw new Fault('INVALID_INPUT', 'Provide sceneOrder, a boolean music setting or a sound configuration', {status: 400});
    }
    return submit(executor, await stageJob(project, {
      sourceRevisionId: source.revisionId, sceneOrder, music: music ?? sourceRequest.music, sound, voiceChanged,
    }, sourceRequest.job?.modelProvider ?? options.modelProvider));
  });
}

export function cancelRevision(executor, projectId, revisionId) {
  return serialize(projectId, async () => {
    const job = await checkedRevision(projectId, revisionId);
    const current = await read(statusFile(job));
    if (current.status === 'cancelled') return {projectId, revisionId, status: 'cancelled'};
    if (!active(current.status)) throw new Fault('REVISION_TERMINAL', 'The revision is already complete', {status: 409});
    await executor.cancel((await read(requestFile(job))).job);
    return {projectId, revisionId, status: (await read(statusFile(job))).status, cancellationRequested: true};
  });
}

export function retryRevision(executor, projectId, revisionId) {
  return serialize(projectId, async () => {
    const job = await checkedRevision(projectId, revisionId);
    const project = await metadata(projectId);
    if (project.latestRevisionId !== revisionId) throw new Fault('STALE_REVISION', 'Retry the latest revision', {status: 409});
    const {status} = await read(statusFile(job));
    const {job: saved, ...details} = await read(requestFile(job));
    if (status === 'queued') return submit(executor, saved);
    if (status !== 'failed' && status !== 'cancelled') throw new Fault('REVISION_NOT_RETRYABLE', 'Only queued, failed or cancelled revisions can be retried', {status: 409});
    const {options} = await read(settingsFile(projectId));
    const modelProvider = saved.modelProvider ?? options.modelProvider;
    const billing = details.sourceRevisionId && !saved.billing ? undefined
      : await productionQuote(project.owner, modelProvider, options.sceneCount, saved.billing);
    const next = await stageJob(project, details, modelProvider, billing);
    if (!details.sourceRevisionId) {
      const from = revisionDir(job);
      const to = revisionDir(next);
      for (const name of ['sources.json', 'figures.json', 'evidence.json', 'plan.json', 'voice.json']) {
        if (await maybe(join(from, name))) await share(join(from, name), join(to, name));
      }
      for (const figure of (await optional(join(from, 'figures.json'))) || []) {
        if (figure.artifact) await share(join(from, figure.artifact), join(to, figure.artifact));
      }
    }
    return submit(executor, next);
  });
}

export async function resumeProjects(executor) {
  for (const project of await listProjects()) {
    const job = {projectId: project.id, revisionId: project.latestRevisionId};
    const {status} = await read(statusFile(job));
    if (status === 'queued' || (executor.isActive && status === 'running')) {
      await submit(executor, (await read(requestFile(job))).job);
    }
  }
}
