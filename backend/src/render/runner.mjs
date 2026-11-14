import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {json, maybe, read, sleep, spool, UUID} from '../common.mjs';
import {bundle} from './driver.mjs';

const task = fileURLToPath(new URL('task.mjs', import.meta.url));
const clean = new AbortController();
for (const event of ['SIGTERM', 'SIGINT']) process.on(event, () => clean.abort());
await mkdir(spool, {recursive: true});
const scratch = await mkdtemp(join(tmpdir(), 'knovid-remotion-'));

function execute(dir, bundled, deadline) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [task, dir, bundled], {stdio: 'ignore', detached: true, env: process.env});
    function stop() {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') console.error('Could not stop renderer');
      }
    }
    const duration = Math.max(1000, Math.min(deadline - Date.now(), 250_000));
    const timeout = setTimeout(stop, duration);
    clean.signal.addEventListener('abort', stop, {once: true});
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timeout);
      clean.signal.removeEventListener('abort', stop);
      if (code === 0) resolve();
      else reject(new Error('Renderer process exceeded its limits or exited'));
    });
  });
}

try {
  const bundled = await bundle(join(scratch, 'bundle'));
  console.info('KnoVid Remotion executor ready');
  const id = new RegExp('^' + UUID + '$');
  while (!clean.signal.aborted) {
    const entries = await readdir(spool);
    let claimed = false;
    for (const entry of entries.filter(name => id.test(name)).sort()) {
      if (clean.signal.aborted) break;
      const dir = join(spool, entry);
      const request = await read(join(dir, 'request.json')).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!request) {
        const info = await stat(dir).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 1_800_000) await rm(dir, {recursive: true, force: true});
        continue;
      }
      if (Date.now() > request.deadline + 60_000) {
        await rm(dir, {recursive: true, force: true});
        continue;
      }
      if (Date.now() >= request.deadline || await maybe(join(dir, 'result.json'))) continue;
      try {
        await mkdir(join(dir, 'claim'));
      } catch (error) {
        if (['EEXIST', 'ENOENT'].includes(error.code)) continue;
        throw error;
      }
      claimed = true;
      try {
        await execute(dir, bundled, request.deadline);
      } catch (error) {
        if (await maybe(join(dir, 'request.json'))) await json(join(dir, 'result.json'), {ok: false, detail: error.message});
      }
      break;
    }
    if (!claimed) await sleep(350, clean.signal).catch(() => {});
  }
} finally {
  await rm(scratch, {recursive: true, force: true});
}
