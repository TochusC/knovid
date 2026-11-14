import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {bundle, renderToDisk} from '../src/render/driver.mjs';
import {media, run} from '../src/common.mjs';

const code = await readFile(new URL('../../demos/neural-network/scene.js', import.meta.url), 'utf8');
const output = fileURLToPath(new URL('../../frontend/public/examples/', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'knovid-neural-sample-'));
const seconds = 20;
const fps = 24;
const signal = AbortSignal.timeout(450_000);
const music = join(work, 'score.wav');

async function writeScore() {
  const sampleRate = 44100;
  const samples = sampleRate * seconds;
  const audio = Buffer.alloc(44 + samples * 4);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(2, 22);
  audio.writeUInt32LE(sampleRate, 24);
  audio.writeUInt32LE(sampleRate * 4, 28);
  audio.writeUInt16LE(4, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(audio.length - 44, 40);

  const tempo = 0.48;
  const notes = [
    [50, 57, 62, 64, 66], [47, 54, 57, 62, 64], [43, 50, 57, 59, 62],
    [45, 52, 55, 59, 61], [50, 57, 61, 64, 66],
  ];
  const arpeggio = [0, 2, 4, 1, 3, 2, 4, 1];
  const mix = [new Float32Array(samples), new Float32Array(samples)];
  function addNote(start, midi, length, level, pan, pad) {
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const attack = pad ? 0.40 : 0.042;
    const from = Math.round(start * sampleRate);
    const to = Math.min(samples, from + Math.round(length * sampleRate));
    for (let i = from; i < to; i++) {
      const time = (i - from) / sampleRate;
      const wave = 2 * Math.PI * frequency * time;
      const envelope = Math.min(1, time / attack) * ((1 - time / length) ** 1.6);
      const tone = Math.sin(wave) + Math.sin(wave * 2 + Math.sin(wave * 0.5) * 0.32) * 0.25 +
        Math.sin(wave * 3 + 0.13) * (pad ? 0.036 : 0.11);
      mix[0][i] += tone * envelope * level * Math.sqrt(0.5 * (1 - pan));
      mix[1][i] += tone * envelope * level * Math.sqrt(0.5 * (1 + pan));
    }
  }
  notes.forEach((chord, bar) => {
    const start = bar * tempo * 8;
    addNote(start, chord[0], 4.5, 0.075, 0, true);
    addNote(start + 0.3, chord[2] + 12, 4.0, 0.040, -0.33, true);
    addNote(start + 0.5, chord[3] + 12, 4.0, 0.046, 0.33, true);
    arpeggio.forEach((note, i) => {
      const at = start + 0.30 + i * tempo;
      const pitch = chord[note] + (note === 0 ? 12 : 24);
      const side = i % 2 ? 0.26 : -0.26;
      addNote(at, pitch, 1.15, 0.085 - 0.018 * (i % 3), side, false);
      addNote(at + 0.20, pitch, 1.15, 0.024, -side, false);
    });
  });
  [[4.58, 86], [7.02, 81], [9.28, 83], [16.85, 90], [17.15, 93]].forEach(([at, pitch]) =>
    addNote(at, pitch, 1.10, 0.049, 0, false));
  for (let i = 0; i < samples; i++) {
    const time = i / sampleRate;
    const gain = Math.min(1, time / 0.4, (seconds - time) / 1.3);
    audio.writeInt16LE(Math.round(mix[0][i] * gain * 32767), 44 + i * 4);
    audio.writeInt16LE(Math.round(mix[1][i] * gain * 32767), 46 + i * 4);
  }
  await writeFile(music, audio);
}

try {
  await mkdir(output, {recursive: true});
  await writeScore();
  const visual = join(work, 'raw.mp4');
  const input = {width: 1280, height: 720, fps, durationFrames: seconds * fps, params: {}, cues: {}, captions: []};
  const bundleLocation = await bundle(join(work, 'bundle'));
  await renderToDisk({code, input, start: 0, end: input.durationFrames - 1}, work, {driver: 'remotion', bundleLocation, signal});
  const video = join(output, 'neural-network.mp4');
  await run('ffmpeg', ['-y', '-v', 'error', '-i', visual, '-i', music, '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', video], {signal});
  const info = await media(video, signal);
  assert.equal(Number(info.streams.find(stream => stream.codec_type === 'video')?.nb_frames), input.durationFrames);
  assert.equal(info.streams.find(stream => stream.codec_type === 'audio')?.codec_name, 'aac');
  assert.ok(Math.abs(Number(info.format.duration) - seconds) < 0.05);
  const poster = join(work, 'poster.png');
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', '5.35', '-i', video, '-frames:v', '1', '-vf', 'scale=960:-1', poster], {signal});
  await run('cwebp', ['-quiet', '-q', '84', poster, '-o', join(output, 'neural-network.webp')], {signal});
  console.log(`Neural-network sample saved to ${video}`);
} finally {
  await rm(work, {recursive: true, force: true});
}
