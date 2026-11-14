import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {link, mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {sceneIdPattern} from './scene-limits.mjs';

export const root = resolve(process.env.KNOVID_DATA || 'data');
export const spool = resolve(process.env.KNOVID_SPOOL || 'render-spool');
export const fixture = process.env.KNOVID_MODE === 'fixture';
export const FPS = 25;
export const UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
export const sceneId = new RegExp('^' + sceneIdPattern + '$');
export const projectDir = id => join(root, 'projects', id);
export const revisionDir = ({projectId, revisionId}) => join(projectDir(projectId), 'revisions', revisionId);
export const sceneDir = (job, id) => join(revisionDir(job), 'scenes', id);
export const read = async file => JSON.parse(await readFile(file, 'utf8'));
export const maybe = async file => (await stat(file).catch(error => {
  if (error.code !== 'ENOENT') throw error;
})) !== undefined;
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, {once: true});
});

export class Fault extends Error {
  constructor(code, message, {status = 422, retryable = false, retryAfterMs} = {}) {
    super(message);
    this.name = 'Fault';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export async function atomic(file, contents) {
  await mkdir(dirname(file), {recursive: true});
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, contents);
    await rename(temp, file);
  } finally {
    await rm(temp, {force: true});
  }
}

export const json = (file, value) => atomic(file, JSON.stringify(value, null, 2) + '\n');

export async function share(from, to) {
  await mkdir(dirname(to), {recursive: true});
  try {
    await link(from, to);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

export async function cached(job, group, inputs, build) {
  const dir = join(projectDir(job.projectId), 'cache', group);
  const key = hash(inputs);
  const file = join(dir, key + '.json');
  if (await maybe(file)) return read(file);
  await mkdir(dir, {recursive: true});
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(await build()));
    await share(temp, file);
    return read(file);
  } finally {
    await rm(temp, {force: true});
  }
}

export async function run(command, args, {signal, timeout = 120000, cwd} = {}) {
  try {
    return await promisify(execFile)(command, args, {signal, timeout, cwd, maxBuffer: 16 * 1024 * 1024});
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') throw new Fault('MISSING_COMMAND', 'Runtime command unavailable: ' + command);
    const tail = (error.stderr || '').trim().slice(-450);
    throw new Fault('COMMAND_FAILED', command + ' failed' + (tail ? ': ' + tail : ''), {retryable: error.killed});
  }
}

export async function media(file, signal) {
  const {stdout} = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,nb_frames,width,height',
    '-of', 'json', file,
  ], {signal});
  return JSON.parse(stdout);
}

export async function concat(cwd, files, target, signal, timeout = 180_000) {
  const list = await mkdir(join(cwd, 'concat-' + randomUUID()), {recursive: true});
  try {
    for (const [index, file] of files.entries()) await share(file, join(list, String(index)));
    await writeFile(join(list, 'list'), files.map((_, i) => "file '" + i + "'").join('\n') + '\n');
    await run('ffmpeg', [
      '-y', '-v', 'error', '-f', 'concat', '-safe', '1', '-i', join(list, 'list'), '-c', 'copy', target,
    ], {signal, timeout});
  } finally {
    await rm(list, {recursive: true, force: true});
  }
}
