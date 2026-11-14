import assert from 'node:assert/strict';
import {test} from 'node:test';
import {alignSpeech} from '../src/activities/audio.mjs';
import {designSound} from '../src/mix.mjs';

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
