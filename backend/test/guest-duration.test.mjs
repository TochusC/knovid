import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const storage = await mkdtemp(join(tmpdir(), 'knovid-guest-duration-'));
process.env.KNOVID_MODE = 'fixture';
process.env.KNOVID_DATA = storage;
const {FPS, atomic, json, maybe, media, projectDir, read, revisionDir, run, sceneDir} = await import('../src/common.mjs');
const {synthesize} = await import('../src/activities/audio.mjs');
const {assemble} = await import('../src/activities/assembly.mjs');
const {fixtureLines} = await import('../src/activities/agents.mjs');
const {requireSceneDuration, requireTotalDuration, sceneFrameLimit} = await import('../src/guest-limits.mjs');

const limited = {language: 'zh', sceneCount: 3, maxDurationSeconds: 30, music: false, effects: false};
const tooLong = error => error.code === 'GUEST_DURATION_LIMIT' && error.status === 422;
const signal = new AbortController().signal;

async function scriptJob(lines, options = limited, projectId = randomUUID()) {
  const job = {projectId, revisionId: randomUUID()};
  await json(join(projectDir(projectId), 'input.json'), {options});
  await json(join(revisionDir(job), 'voice.json'), {rate: 0, pitch: 0});
  await json(join(revisionDir(job), 'request.json'), {});
  await json(join(sceneDir(job, 's1'), 'script.json'), {
    segments: lines.map((text, index) => ({text, cue: 'cue-' + index, pauseMs: 250})),
  });
  return job;
}

try {
  await test('guest duration validation rejects invalid measured durations and reserves rounding room', () => {
    const boundary = sceneFrameLimit(limited);
    assert.ok(boundary * 3 / FPS < 30);
    assert.doesNotThrow(() => requireSceneDuration(limited, boundary));
    assert.throws(() => requireSceneDuration(limited, boundary + 1), tooLong);
    assert.doesNotThrow(() => requireTotalDuration(limited, 30));
    for (const value of [30.001, NaN, Infinity, 0, -1]) assert.throws(() => requireTotalDuration(limited, value), tooLong);
    for (const value of [NaN, Infinity, 0, -1]) assert.throws(() => requireSceneDuration(limited, value), tooLong);
    assert.doesNotThrow(() => requireTotalDuration({language: 'zh'}, 75));
  });

  await test('guest speech uses actual decoded audio length and preserves the complete short narration', async () => {
    const job = await scriptJob([fixtureLines[0]]);
    const frames = await synthesize(job, 's1', signal);
    const timing = await read(join(sceneDir(job, 's1'), 'timing.json'));
    const measured = await media(join(sceneDir(job, 's1'), 'audio.wav'), signal);
    assert.equal(timing.hasSpeech, true);
    assert.equal(timing.captions[0].text, fixtureLines[0]);
    assert.equal(timing.durationFrames, frames);
    assert.ok(Number(measured.format.duration) <= sceneFrameLimit(limited) / FPS);
    assert.ok(Math.abs(Number(measured.format.duration) - frames / FPS) < 0.001);
  });

  await test('disabling narration preserves the animation cues without adding speech or captions', async () => {
    const job = await scriptJob([fixtureLines[0]], {...limited, narration: false, music: true});
    const frames = await synthesize(job, 's1', signal);
    const timing = await read(join(sceneDir(job, 's1'), 'timing.json'));
    const measured = await media(join(sceneDir(job, 's1'), 'audio.wav'), signal);
    assert.equal(timing.hasSpeech, false);
    assert.deepEqual(timing.captions, []);
    assert.ok(timing.cues['cue-0'] > 0);
    assert.equal(Number(measured.format.duration), frames / FPS);
  });

  await test('overlong real speech is rejected without publishing truncated audio or timing, including cache reuse', async () => {
    const lines = [fixtureLines[2], fixtureLines[2], fixtureLines[2], fixtureLines[2]];
    const rejected = await scriptJob(lines);
    await assert.rejects(synthesize(rejected, 's1', signal), tooLong);
    assert.equal(await maybe(join(sceneDir(rejected, 's1'), 'audio.wav')), false);
    assert.equal(await maybe(join(sceneDir(rejected, 's1'), 'timing.json')), false);

    // A complete unrestricted recording establishes that the spoken audio really exceeds the budget.
    const unrestricted = await scriptJob(lines, {language: 'zh', sceneCount: 3});
    await synthesize(unrestricted, 's1', signal);
    const measured = await media(join(sceneDir(unrestricted, 's1'), 'audio.wav'), signal);
    assert.ok(Number(measured.format.duration) > 10);
    const cached = await scriptJob(lines, limited, unrestricted.projectId);
    await assert.rejects(synthesize(cached, 's1', signal), tooLong);
    assert.equal(await maybe(join(sceneDir(cached, 's1'), 'audio.wav')), false);
    assert.equal(await maybe(join(sceneDir(cached, 's1'), 'timing.json')), false);
    await assert.rejects(synthesize(unrestricted, 's1', signal), tooLong);
  });

  await test('assembly rejects a timeline longer than 30 seconds before publishing any output', async () => {
    const job = await scriptJob([fixtureLines[0]]);
    await json(join(revisionDir(job), 'plan.json'), {title: 'Duration boundary'});
    const ids = ['s1', 's2', 's3'];
    for (const id of ids) {
      await json(join(sceneDir(job, id), 'timing.json'), {durationFrames: 251, captions: [], cues: {}, hasSpeech: true});
      await json(join(sceneDir(job, id), 'program.json'), {paramSchema: {}, params: {}});
    }
    await assert.rejects(assemble(job, ids, signal), tooLong);
    for (const name of ['video.mp4', 'manifest.json', 'project.zip']) {
      assert.equal(await maybe(join(revisionDir(job), name)), false);
    }
  });

  await test('three complete fixture narrations assemble and mix into a real MP4 within 30 seconds', async () => {
    const job = await scriptJob([fixtureLines[0]], {...limited, music: true, effects: true});
    const dir = revisionDir(job);
    await json(join(dir, 'evidence.json'), {facts: [], sources: []});
    await json(join(dir, 'plan.json'), {title: 'Guest media integration'});
    const ids = ['s1', 's2', 's3'];
    const frames = [];
    let lastCaptionEnd = 0;
    for (const [index, id] of ids.entries()) {
      const folder = sceneDir(job, id);
      await json(join(folder, 'script.json'), {segments: [{text: fixtureLines[index], cue: 'explain', pauseMs: 250}]});
      const length = await synthesize(job, id, signal);
      const timing = await read(join(folder, 'timing.json'));
      assert.equal(timing.hasSpeech, true);
      assert.deepEqual(timing.captions.map(caption => caption.text), [fixtureLines[index]]);
      assert.ok(timing.captions.at(-1).end <= length / FPS);
      lastCaptionEnd = frames.reduce((sum, value) => sum + value, 0) / FPS + timing.captions.at(-1).end;
      frames.push(length);
      // Solid frames are test fixtures only; this exercises audio, muxing and packaging without Chromium.
      await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x4455aa:s=160x90:r=' + FPS,
        '-frames:v', String(length), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(folder, 'visual.mp4')], {signal});
      await run('ffmpeg', ['-y', '-v', 'error', '-i', join(folder, 'visual.mp4'), '-frames:v', '1', join(folder, 'frame.png')], {signal});
      await json(join(folder, 'program.json'), {paramSchema: {}, params: {}});
      await json(join(folder, 'review.json'), {accepted: true});
      await atomic(join(folder, 'scene.mjs'), '// Test-only solid-color scene fixture.\n');
    }
    await assemble(job, ids, signal);
    const measured = await media(join(dir, 'video.mp4'), signal);
    const manifest = await read(join(dir, 'manifest.json'));
    const duration = Number(measured.format.duration);
    const totalFrames = frames.reduce((sum, value) => sum + value, 0);
    assert.ok(duration <= 30, 'Final container duration exceeds the guest limit');
    assert.ok(duration >= lastCaptionEnd, 'Final media must include the end of the complete last narration');
    assert.ok(Math.abs(duration - totalFrames / FPS) <= 0.14);
    assert.equal(Number(measured.streams.find(stream => stream.codec_type === 'video').nb_frames), totalFrames);
    assert.ok(measured.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    assert.equal(manifest.durationFrames, totalFrames);
    assert.ok(manifest.scenes.every(scene => scene.hasSpeech));
    assert.ok(manifest.sound.credits.length > 0);
    const subtitles = await readFile(join(dir, 'subtitles.vtt'), 'utf8');
    for (const line of fixtureLines) assert.ok(subtitles.includes(line));
    const bundle = await readFile(join(dir, 'project.zip'));
    assert.equal(bundle.subarray(0, 2).toString(), 'PK');
  });
} finally {
  await rm(storage, {recursive: true, force: true});
}
