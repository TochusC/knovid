import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {alignSpeech} from '../src/activities/audio.mjs';
import {run} from '../src/common.mjs';
import {designSound, mixVideo} from '../src/mix.mjs';

test('phrase alignment preserves progression when Edge merges sentences into one boundary', () => {
  const srt = '1\n00:00:00,100 --> 00:00:03,100\n先看太阳。再看这一侧。\n\n2\n00:00:03,100 --> 00:00:05,100\n所以两者相等。\n';
  const timings = alignSpeech(['先看太阳。', '再看这一侧。', '所以两者相等。'], srt, 5);
  assert.equal(timings[0].start, 0.1);
  assert.equal(timings[1].start, timings[0].end);
  assert.equal(timings[2].start, 3.1);
  assert.equal(timings[2].end, 5);
});

test('the mix records credits for assets used and can disable music or effects independently', () => {
  const scenes = [{timing: {durationFrames: 53, cues: {one: 8, two: 26}}}, {timing: {durationFrames: 83, cues: {three: 9}}}];
  const musicOnly = designSound(scenes, 25, {music: true, musicTrack: 'exploration', effects: false});
  assert.deepEqual(musicOnly.credits.map(item => item.id), ['exploration']);
  const sound = designSound(scenes, 25, {music: false});
  assert.equal(sound.music, null);
  assert.ok(sound.effects.every(event => event.time < 136 / 25));
  assert.deepEqual(sound.credits.map(item => item.id), ['transition', 'accent', 'resolve']);
});

test('late speech cues cannot place sound effects beyond their scene', () => {
  const late = designSound([{timing: {durationFrames: 40, cues: {last: 39}}}], 25, {music: false});
  assert.deepEqual(late.credits.map(item => item.id), ['transition']);
  const nearEnd = designSound([{timing: {durationFrames: 40, cues: {last: 30}}}], 25, {music: false});
  assert.ok(nearEnd.effects.some(effect => effect.id === 'resolve'));
  assert.ok(nearEnd.effects.every(effect => effect.time <= 1.4));
});

test('silent narration and mixed cue effects produce a stereo AAC track', async t => {
  const work = await mkdtemp(join(tmpdir(), 'knovid-silent-mix-'));
  t.after(() => rm(work, {recursive: true, force: true}));
  const visual = join(work, 'visual.mp4');
  const narration = join(work, 'silent.wav');
  const target = join(work, 'mixed.mp4');
  const duration = 18;
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:r=25',
    '-t', String(duration), '-an', '-c:v', 'libx264', visual]);
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
    '-t', String(duration), '-c:a', 'pcm_s16le', narration]);

  const scenes = Array.from({length: 3}, () => ({timing: {durationFrames: 150, cues: {focus: 38}}}));
  const sound = designSound(scenes, 25, {music: false});
  assert.deepEqual(sound.effects.map(effect => effect.id), ['transition', 'accent', 'transition', 'resolve']);
  await mixVideo({visual, narration, target, duration, sound, signal: AbortSignal.timeout(15_000)});
  const {stdout} = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=codec_name,sample_rate,channel_layout,duration', '-of', 'json', target]);
  const [audio] = JSON.parse(stdout).streams;
  assert.equal(audio.codec_name, 'aac');
  assert.equal(audio.sample_rate, '48000');
  assert.equal(audio.channel_layout, 'stereo');
  assert.ok(Math.abs(Number(audio.duration) - duration) <= 0.04);
});
