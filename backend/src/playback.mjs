import {randomUUID} from 'node:crypto';
import {rename, rm} from 'node:fs/promises';
import {run} from './common.mjs';

export async function makePlayback(source, target, {signal, timeout = 360_000} = {}) {
  const temp = target + '.' + randomUUID() + '.mp4';
  try {
    await run('ffmpeg', [
      '-nostdin', '-v', 'error', '-i', source, '-map', '0:v:0', '-map', '0:a:0?',
      '-filter_threads', '1', '-vf', 'fps=20,scale=-2:min(360\\,ih)',
      '-c:v', 'libx264', '-threads:v', '2', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-crf', '33', '-maxrate', '160k', '-bufsize', '160k', '-g', '40',
      '-c:a', 'aac', '-ac', '1', '-ar', '24000', '-b:a', '48k', '-movflags', '+faststart', temp,
    ], {signal, timeout});
    signal?.throwIfAborted();
    await rename(temp, target);
  } finally {
    await rm(temp, {force: true});
  }
}
