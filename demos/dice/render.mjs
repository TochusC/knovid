// Run from the repository with backend dependencies, FFmpeg, cwebp and Chromium installed.
// Set CHROMIUM_EXECUTABLE when Playwright's bundled browser is unavailable.
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {chromium} from '../../backend/node_modules/playwright-core/index.mjs';

const FPS = 30;
const duration = 20;
const output = fileURLToPath(new URL('../../frontend/public/examples/', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'knovid-dice-'));
const scene = await readFile(new URL('./scene.js', import.meta.url), 'utf8');
const audio = join(directory, 'score.wav');
const cover = join(directory, 'cover.png');

function writeScore() {
  const rate = 48000;
  const frames = rate * duration;
  const samples = [new Float32Array(frames), new Float32Array(frames)];
  const chords = [[62, 65, 69, 72], [58, 62, 65, 69], [60, 64, 67, 71], [57, 60, 64, 67]];
  const frequency = midi => 440 * 2 ** ((midi - 69) / 12);
  function tone(start, length, midi, volume, pan, pad) {
    const first = Math.round(start * rate);
    const lengthInFrames = Math.min(Math.round(length * rate), frames - first);
    const hz = frequency(midi);
    const left = Math.cos((pan + 1) * Math.PI / 4);
    const right = Math.sin((pan + 1) * Math.PI / 4);
    for (let i = 0; i < lengthInFrames; i++) {
      const t = i / rate;
      const phase = 2 * Math.PI * hz * t;
      const attack = pad ? 0.35 : 0.035;
      const release = pad ? 0.9 : 0.3;
      const envelope = Math.min(1, t / attack, (length - t) / release);
      const signal = Math.sin(phase) + 0.24 * Math.sin(phase * 2.003) + 0.067 * Math.sin(phase * 3.02);
      const amplitude = volume * envelope * signal * (pad ? 1 : Math.exp(-t * 2.4));
      samples[0][first + i] += amplitude * left;
      samples[1][first + i] += amplitude * right;
    }
  }

  for (let bar = 0; bar < 10; bar++) {
    const start = bar * 2;
    const chord = chords[bar % chords.length];
    tone(start, 2.6, chord[0] - 12, 0.034, -0.15, true);
    for (let i = 0; i < chord.length; i++) {
      tone(start + i * 0.04, 2.45, chord[i], 0.013, (i - 1.5) * 0.37, true);
    }
    const pattern = bar % 2 === 0 ? [0, 1, 3, 2, 3] : [0, 2, 1, 3, 2];
    for (const [i, note] of pattern.entries()) {
      tone(start + [0.12, 0.44, 0.78, 1.22, 1.68][i], 0.87,
        chord[note] + 12, i === 0 ? 0.09 : 0.055, Math.sin(i * 1.32) * 0.46, false);
    }
  }
  for (const [i, time] of [1.6, 2.35, 3.1, 3.83, 4.56, 5.27, 5.98, 6.65, 7.3, 7.96].entries()) {
    tone(time, 0.16, i === 6 ? 88 : 74 + i % 5, 0.13, 0.2, false);
  }
  tone(17.1, 1.28, 86, 0.1, -0.2, false);
  tone(17.32, 1.28, 89, 0.08, 0.2, false);

  const wav = Buffer.alloc(44 + frames * 4);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const gain = Math.min(1, i / (rate * 0.55), (frames - i) / (rate * 1.45));
    for (let channel = 0; channel < 2; channel++) {
      wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[channel][i] * gain * 2)) * 32767), 44 + i * 4 + channel * 2);
    }
  }
  return writeFile(audio, wav);
}

const launchOptions = process.env.CHROMIUM_EXECUTABLE
  ? {executablePath: process.env.CHROMIUM_EXECUTABLE}
  : {};
let browser;
let encoder;
try {
  await writeScore();
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><canvas></canvas>');
  await page.addScriptTag({content: scene});
  async function image(time) {
    const base64 = await page.evaluate(t => {
      window.drawDiceSample(t);
      return document.querySelector('canvas').toDataURL('image/png').split(',', 2)[1];
    }, time);
    return Buffer.from(base64, 'base64');
  }
  await writeFile(cover, await image(6.17));
  encoder = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(FPS), '-f', 'image2pipe', '-vcodec', 'png', '-i', 'pipe:0',
    '-i', audio, '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-shortest', join(output, 'dice.mp4'),
  ], {stdio: ['pipe', 'inherit', 'inherit']});
  const encoding = once(encoder, 'close');
  for (let i = 0; i < FPS * duration; i++) {
    if (!encoder.stdin.write(await image(i / FPS))) await once(encoder.stdin, 'drain');
  }
  encoder.stdin.end();
  const [status] = await encoding;
  if (status !== 0) throw new Error('FFmpeg could not encode the dice video');
  const webp = spawnSync('cwebp', ['-quiet', '-q', '82', cover, '-o', join(output, 'dice.webp')], {stdio: 'inherit'});
  if (webp.error) throw webp.error;
  if (webp.status !== 0) throw new Error('cwebp could not encode the dice cover');
} finally {
  encoder?.stdin.destroy();
  await browser?.close();
  await rm(directory, {recursive: true, force: true});
}
