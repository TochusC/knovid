import {randomUUID} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, rename, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {Fault, FPS, concat, fixture, hash, json, media, maybe, projectDir, read, revisionDir, run, sceneDir, share, sleep, spool} from '../common.mjs';
import {designSound, mixVideo} from '../mix.mjs';

const local = process.env.KNOVID_EXECUTOR === 'local';
const driver = process.env.KNOVID_LOCAL_RENDERER || 'remotion';
if (local && !fixture) {
  throw new Error('Use Temporal and the isolated render executor for live projects. Local execution supports KNOVID_MODE=fixture.');
}
const renderMode = local ? driver : 'remotion';

async function requestRender(request, target, signal) {
  const id = randomUUID();
  const name = request.still ? 'frame.png' : 'raw.mp4';
  const dir = local ? await mkdtemp(join(tmpdir(), 'knovid-render-')) : join(spool, id);
  await mkdir(dir, {recursive: true});
  const temp = target + '.' + id + '.tmp';
  try {
    if (local) {
      const {renderToDisk} = await import('../render/driver.mjs');
      await renderToDisk(request, dir, {driver, signal});
    } else {
      const deadline = Date.now() + 290_000;
      await json(join(dir, 'request.json'), {...request, deadline});
      const resultFile = join(dir, 'result.json');
      while (!(await maybe(resultFile))) {
        if (Date.now() >= deadline) throw new Fault('RENDER_TIMEOUT', 'No renderer completed the chunk before its deadline', {retryable: true});
        await sleep(450, signal);
      }
      const result = await read(resultFile);
      if (!result.ok) throw new Fault('RENDER_ERROR', 'Scene rendering failed: ' + String(result.detail).slice(0, 240));
    }
    await copyFile(join(dir, name), temp);
    await share(temp, target);
  } finally {
    await Promise.all([rm(temp, {force: true}), rm(dir, {force: true, recursive: true})]);
  }
}

async function sceneInputs(job, id) {
  const dir = sceneDir(job, id);
  const [program, timing, {options}] = await Promise.all([
    read(join(dir, 'program.json')), read(join(dir, 'timing.json')), read(join(projectDir(job.projectId), 'input.json')),
  ]);
  const input = {width: options.width, height: options.height, fps: timing.fps, durationFrames: timing.durationFrames,
    cues: timing.cues, captions: timing.captions, params: program.params};
  return {dir, input, code: program.code};
}

export async function checkFrame(job, id, signal) {
  const path = join(sceneDir(job, id), 'frame.png');
  if (await maybe(path)) return {ok: true};
  const {input, code} = await sceneInputs(job, id);
  const start = Math.max(0, Math.min(input.durationFrames - 1, (Object.values(input.cues)[0] ?? 0) + 16));
  try {
    await requestRender({input, code, start, still: true}, path, signal);
    return {ok: true};
  } catch (error) {
    signal.throwIfAborted();
    if (error.retryable || (!local && !['RENDER_ERROR', 'FRAME_COUNT'].includes(error.code))) throw error;
    return {ok: false, reason: error.message};
  }
}

export async function renderInfo(job, id) {
  const dir = sceneDir(job, id);
  const {durationFrames} = await read(join(dir, 'timing.json'));
  const {scenes} = await read(join(dir, '..', '..', 'plan.json'));
  return {durationFrames, heavy: scenes.find(scene => scene.id === id).heavy};
}

const chunkName = start => 'chunk-' + start + '.mp4';

export async function renderChunk(job, id, start, end, signal) {
  const {dir, input, code} = await sceneInputs(job, id);
  const file = join(dir, 'chunks', chunkName(start));
  if (await maybe(file)) return;
  const key = hash([2, renderMode, input, code, start, end]);
  const cached = join(projectDir(job.projectId), 'cache', 'video', key + '.mp4');
  await mkdir(dirname(cached), {recursive: true});
  if (!(await maybe(cached))) await requestRender({input, code, start, end, still: false}, cached, signal);
  await share(cached, file);
}

export async function completeScene(job, id, starts, signal) {
  const dir = sceneDir(job, id);
  const visual = join(dir, 'visual.mp4');
  const preview = join(dir, 'preview.mp4');
  if (await maybe(preview)) return;
  const tmp = join(dir, 'preview-' + randomUUID() + '.mp4');
  const interim = join(dir, 'visual-' + randomUUID() + '.mp4');
  try {
    if (!(await maybe(visual))) {
      if (starts.length === 1) await share(join(dir, 'chunks', chunkName(starts[0])), visual);
      else {
        await concat(dir, starts.map(start => join(dir, 'chunks', chunkName(start))), interim, signal);
        await share(interim, visual);
      }
    }
    const [{options}, request, timing] = await Promise.all([
      read(join(projectDir(job.projectId), 'input.json')), read(join(revisionDir(job), 'request.json')), read(join(dir, 'timing.json')),
    ]);
    const sound = designSound([{id, timing}], FPS, {...options, music: request.music ?? options.music, ...request.sound});
    await mixVideo({visual, narration: join(dir, 'audio.wav'), target: tmp, duration: timing.durationFrames / FPS, sound, signal});
    const probe = await media(tmp, signal);
    if (probe.streams.length !== 2) throw new Fault('INVALID_PREVIEW', 'Preview must contain video and an audio track');
    await rename(tmp, preview);
  } finally {
    await Promise.all([rm(tmp, {force: true}), rm(interim, {force: true})]);
  }
}
