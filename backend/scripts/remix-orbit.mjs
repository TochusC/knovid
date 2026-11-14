import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';

const [, , video, target] = process.argv;
if (!video || !target || !target.endsWith('.mp4')) {
  throw new Error('Usage: node scripts/remix-orbit.mjs INPUT.mp4 OUTPUT.mp4');
}
const out = resolve(target);
const work = await mkdtemp(join(tmpdir(), 'knovid-orbit-remix-'));
process.env.KNOVID_MODE = 'live';
process.env.KNOVID_DATA = work;
const {designSound, mixVideo} = await import('../src/mix.mjs');
const {catalog, credit} = await import('../src/sound.mjs');
const {json, media, projectDir, read, revisionDir, sceneDir} = await import('../src/common.mjs');
const {synthesize} = await import('../src/activities/audio.mjs');
const signal = AbortSignal.timeout(110_000);
const job = {projectId: 'orbit', revisionId: 'audio-v2'};
const dir = sceneDir(job, 's1');
const segments = [
  {cue: 'ellipse', text: '行星沿椭圆绕着太阳转。', pauseMs: 100},
  {cue: 'speed', text: '靠近太阳时，它走得更快。', pauseMs: 650},
  {cue: 'shapes', text: '看这两块。', pauseMs: 100},
  {cue: 'areas', text: '用时相同，扫过的面积也一样。', pauseMs: 100},
];

function time(value) {
  const ms = Math.round(value * 1000);
  return '00:' + String(Math.floor(ms / 1000)).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0');
}

try {
  const source = await media(resolve(video), signal);
  const duration = Number(source.format.duration);
  if (Math.abs(duration - 12) > 0.03) throw new Error('Expected the 12 second orbit animation');
  await Promise.all([
    json(join(projectDir(job.projectId), 'input.json'), {options: {language: 'zh', voiceStyle: 'warm'}}),
    json(join(revisionDir(job), 'request.json'), {}),
    json(join(revisionDir(job), 'voice.json'), {rate: 1, pitch: 0}),
    json(join(dir, 'script.json'), {segments}),
    mkdir(dirname(out), {recursive: true}),
  ]);
  await synthesize(job, 's1', signal);
  const timing = await read(join(dir, 'timing.json'));
  if (timing.durationFrames / timing.fps > duration) throw new Error('Narration exceeds the animation duration');
  const soundtrack = designSound([{timing}], timing.fps, {music: true, musicTrack: 'first-light', effects: true});
  soundtrack.effects = [
    {id: 'transition', time: 0.055, gain: -21},
    {id: 'accent', time: 3.49, gain: -21},
    {id: 'transition', time: 6.84, gain: -24},
    {id: 'resolve', time: 10.27, gain: -20},
  ];
  const usedEffects = new Set(soundtrack.effects.map(effect => effect.id));
  soundtrack.credits = [soundtrack.music, ...catalog.effects.filter(effect => usedEffects.has(effect.id)).map(credit)].filter(Boolean);
  await mixVideo({visual: resolve(video), narration: join(dir, 'audio.wav'), target: out, duration, sound: soundtrack, signal});
  const body = timing.captions.map(({start, end, text}) => time(start) + ' --> ' + time(end) + '\n' + text).join('\n\n');
  const stem = out.slice(0, -4);
  await writeFile(stem + '.vtt', 'WEBVTT\n\n' + body + '\n');
  await json(stem + '-credits.json', soundtrack);
  console.log(out);
} finally {
  await rm(work, {recursive: true, force: true});
}
