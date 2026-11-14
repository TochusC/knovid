import {randomUUID} from 'node:crypto';
import {copyFile, mkdir, readdir, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Fault, atomic, concat, FPS, fixture, json, media, maybe, projectDir, read, revisionDir, run, sceneDir, share} from '../common.mjs';
import {designSound, mixVideo} from '../mix.mjs';
import {assetFile, catalog} from '../sound.mjs';
import {requireTotalDuration} from '../guest-limits.mjs';
import {longProductionThreshold} from '../scene-limits.mjs';

function timestamp(seconds) {
  const millis = Math.round(seconds * 1000);
  const values = [Math.floor(millis / 3_600_000), Math.floor(millis / 60_000) % 60, Math.floor(millis / 1000) % 60];
  return values.map(value => String(value).padStart(2, '0')).join(':') + '.' + String(millis % 1000).padStart(3, '0');
}

export async function assemble(job, ids, signal) {
  const dir = revisionDir(job);
  const manifestFile = join(dir, 'manifest.json');
  if (await maybe(manifestFile)) return;
  const work = join(dir, '.assembly-' + randomUUID());
  const base = projectDir(job.projectId);
  const [settings, plan, request] = await Promise.all([
    read(join(base, 'input.json')), read(join(dir, 'plan.json')), read(join(dir, 'request.json')),
  ]);
  const options = {...settings.options, music: request.music ?? settings.options.music, ...request.sound};
  const scenes = await Promise.all(ids.map(async id => {
    const folder = sceneDir(job, id);
    const [timing, program] = await Promise.all([read(join(folder, 'timing.json')), read(join(folder, 'program.json'))]);
    return {id, timing, paramSchema: program.paramSchema, params: program.params};
  }));
  let total = 0;
  const subtitles = [];
  const timeline = scenes.map(({id, timing, ...settings}) => {
    subtitles.push(...timing.captions.map(line =>
      timestamp(total / FPS + line.start) + ' --> ' + timestamp(total / FPS + line.end) + '\n' +
      line.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')));
    const result = {
      id, startFrame: total, durationFrames: timing.durationFrames,
      hasSpeech: timing.hasSpeech, voice: timing.voice, ...settings,
    };
    total += timing.durationFrames;
    return result;
  });
  const duration = total / FPS;
  const longProduction = ids.length > longProductionThreshold;
  const mediaTimeout = longProduction ? 360_000 : 180_000;
  requireTotalDuration(options, duration);
  const sound = designSound(scenes, FPS, options);
  const manifest = {projectId: job.projectId, revisionId: job.revisionId, title: plan.title, options, fixture,
    fps: FPS, durationFrames: total, durationSeconds: duration, scenes: timeline, sound};
  await mkdir(work, {recursive: true});
  try {
    await Promise.all([
      concat(work, ids.map(id => join(sceneDir(job, id), 'visual.mp4')), join(work, 'video.mp4'), signal, mediaTimeout),
      concat(work, ids.map(id => join(sceneDir(job, id), 'audio.wav')), join(work, 'speech.wav'), signal, mediaTimeout),
    ]);
    const output = join(work, 'final.mp4');
    await mixVideo({visual: join(work, 'video.mp4'), narration: join(work, 'speech.wav'),
      target: output, duration, sound, signal, timeout: mediaTimeout});
    const metadata = await media(output, signal);
    requireTotalDuration(options, Number(metadata.format.duration));
    const video = metadata.streams.find(stream => stream.codec_type === 'video');
    if (Number(video?.nb_frames) !== total || !metadata.streams.some(stream => stream.codec_type === 'audio') ||
      Math.abs(Number(metadata.format.duration) - duration) > 0.14) {
      throw new Fault('ASSEMBLY_MISMATCH', 'Video, audio and timeline did not agree');
    }
    await atomic(join(dir, 'subtitles.vtt'), 'WEBVTT\n\n' + subtitles.join('\n\n') + '\n');
    await json(join(dir, 'audio-credits.json'), sound.credits);
    const pack = join(work, 'pack');
    await mkdir(pack);
    await json(join(pack, 'manifest.json'), manifest);
    await share(join(base, 'input.json'), join(pack, 'input.json'));
    for (const name of ['evidence.json', 'plan.json', 'voice.json', 'subtitles.vtt', 'audio-credits.json']) {
      await share(join(dir, name), join(pack, name));
    }
    const usedSounds = [...catalog.music, ...catalog.effects].filter(asset => sound.credits.some(item => item.id === asset.id));
    if (usedSounds.length) {
      const folder = join(pack, 'sound');
      await mkdir(folder, {recursive: true});
      await Promise.all(usedSounds.map(asset => copyFile(assetFile(asset), join(folder, asset.file))));
    }
    for (const name of await readdir(dir)) {
      if (/^paper-page-\d+\.png$/.test(name)) await share(join(dir, name), join(pack, name));
    }
    for (const id of ids) {
      for (const name of ['script.json', 'scene.mjs', 'program.json', 'review.json', 'timing.json', 'audio.wav', 'frame.png']) {
        await share(join(sceneDir(job, id), name), join(pack, 'scenes', id, name));
      }
    }
    await run('zip', ['-q', '-r', join(work, 'project.zip'), '.'], {signal, cwd: pack, timeout: longProduction ? 240_000 : 120_000});
    await rename(output, join(dir, 'video.mp4'));
    await rename(join(work, 'project.zip'), join(dir, 'project.zip'));
    await json(manifestFile, manifest);
  } finally {
    await rm(work, {recursive: true, force: true});
  }
}
