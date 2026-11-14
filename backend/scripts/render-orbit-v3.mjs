import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, copyFile} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {bundle, renderToDisk} from '../src/render/driver.mjs';
import {concat, media, run} from '../src/common.mjs';

const demos = fileURLToPath(new URL('../../demos/', import.meta.url));
const source = join(demos, 'orbit-visual-v3');
const output = resolve(process.argv.find(arg => arg.endsWith('.mp4')) || join(demos, 'orbit-visual-v3.mp4'));
const stills = process.argv.includes('--stills');
const work = await mkdtemp(join(tmpdir(), 'knovid-visual-v3-'));
const code = await readFile(join(source, 'scene.js'), 'utf8');
const timestamp = text => text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
const captions = (await readFile(join(source, 'subtitles.vtt'), 'utf8')).trim().split(/\n\n+/).slice(1).map(block => {
  const [range, ...text] = block.split('\n');
  const [start, end] = range.split(' --> ').map(timestamp);
  return {start, end, text: text.join(' ')};
});
const input = {width: 1920, height: 1080, fps: 60, durationFrames: 720, params: {captions}, cues: {}, captions: []};
const signal = AbortSignal.timeout(600_000);
try {
  if (stills) {
    const folder = resolve(process.env.KNOVID_PREVIEWS || '/tmp/knovid-visual-review');
    await mkdir(folder, {recursive: true});
    for (const frame of [50, 210, 400, 580]) {
      const dir = join(work, String(frame)); await mkdir(dir);
      await renderToDisk({code, input, still: true, start: frame, end: frame}, dir, {driver: 'chromium', signal});
      await copyFile(join(dir, 'frame.png'), join(folder, 'after-' + frame + '.png'));
    }
    console.log('Keyframes saved to ' + folder);
  } else {
    await mkdir(dirname(output), {recursive: true});
    const bundleLocation = await bundle(join(work, 'bundle'));
    const files = await Promise.all([0, 1].map(async index => {
      const dir = join(work, 'part-' + index); await mkdir(dir);
      await renderToDisk({code, input, still: false, start: index * 360, end: index * 360 + 359}, dir,
        {driver: 'remotion', bundleLocation, signal});
      console.log('Rendered frames ' + (index * 360) + '–' + (index * 360 + 359));
      return join(dir, 'raw.mp4');
    }));
    const visual = join(work, 'silent.mp4');
    await concat(work, files, visual, signal);
    await run('ffmpeg', ['-y', '-v', 'error', '-i', visual, '-i', join(source, 'soundtrack.m4a'),
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', output], {signal});
    const info = await media(output, signal);
    assert.equal(info.streams.find(stream => stream.codec_type === 'video').nb_frames, '720');
    assert.equal(info.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
    assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.05);
    await copyFile(join(source, 'subtitles.vtt'), output.replace(/\.mp4$/, '.vtt'));
    await copyFile(join(source, 'audio-credits.json'), output.replace(/\.mp4$/, '-credits.json'));
    console.log(output);
  }
} finally { await rm(work, {recursive: true, force: true}); }
