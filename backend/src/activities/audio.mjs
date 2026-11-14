import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {FPS, Fault, atomic, cached, fixture, hash, json, maybe, projectDir, read, revisionDir, run, sceneDir, share} from '../common.mjs';
import {fixtureLines} from './agents.mjs';
import {configuredVoice} from '../sound.mjs';
import {requireSceneDuration, sceneFrameLimit} from '../guest-limits.mjs';

const sampleRate = 24000;
const samplesPerFrame = sampleRate / FPS;
const pause = ms => Buffer.alloc(Math.round(sampleRate * ms / 1000) * 2);
const signed = value => (value < 0 ? '' : '+') + value;
const voiceFilter = 'highpass=f=74,adeclick,acompressor=threshold=0.1:ratio=2:attack=10:release=100:makeup=1.4';

function wav(samples) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

async function decode(source, work, signal) {
  const raw = join(work, 'voice.pcm');
  await run('ffmpeg', ['-y', '-v', 'error', '-i', source, '-map', '0:a:0', '-af', voiceFilter,
    '-ar', String(sampleRate), '-ac', '1', '-f', 's16le', raw], {signal});
  const pcm = await readFile(raw);
  if (pcm.length < sampleRate * 0.2 || pcm.length > sampleRate * 2 * 58) {
    throw new Fault('TTS_DURATION', 'Speech duration was outside the supported range');
  }
  return pcm;
}

const cleanLine = text => text.replace(/\s+/gu, ' ').trim();
const units = text => Array.from(text.toLowerCase().match(/[\p{L}\p{N}]/gu) || []);
const boundary = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;

function readBoundaries(srt) {
  return srt.replace(/\r/g, '').split(/\n\n+/).flatMap(block => {
    const [, line, ...body] = block.trim().split('\n');
    const match = /^(\d+):(\d+):(\d+),(\d+)\s+-->\s+(\d+):(\d+):(\d+),(\d+)$/.exec(line || '');
    if (!match) return [];
    return [{start: boundary(...match.slice(1, 5)), end: boundary(...match.slice(5)), text: body.join(' ')}];
  });
}

// Match phrases even when the provider merges or splits spoken sentences.
export function alignSpeech(lines, srt, duration) {
  const blocks = readBoundaries(srt);
  const requested = lines.map(units);
  const observed = blocks.map(block => units(block.text));
  if (!observed.length || requested.some(phrase => !phrase.length) ||
    observed.flat().join('') !== requested.flat().join('')) {
    throw new Fault('TTS_ALIGNMENT', 'Speech timing could not be matched to the requested narration');
  }
  const words = blocks.flatMap((block, index) => observed[index].map((_, i, parts) => {
    const start = Math.max(0, Math.min(duration, block.start));
    const end = Math.max(start, Math.min(duration, block.end));
    return [start + (end - start) * i / parts.length, start + (end - start) * (i + 1) / parts.length];
  }));
  let at = 0;
  return requested.map((phrase, index) => {
    const start = words[at][0];
    at += phrase.length;
    const end = index === requested.length - 1 ? words[at - 1][1] :
      Math.min(words[at - 1][1], words[at][0]);
    return {start, end: Math.max(start, end)};
  });
}

function phrases(segments, language) {
  return segments.map(segment => {
    const line = cleanLine(segment.speak || segment.text);
    if (/[\u3002\uff01\uff1f.!?]/u.test(line.at(-1) || '')) return line;
    return line + (language === 'zh' ? '。' : '.');
  });
}

async function liveSpeech(segments, voice, language, work, signal) {
  const lines = phrases(segments, language);
  const original = join(work, 'voice.mp3');
  const srt = join(work, 'voice.srt');
  try {
    await run(process.env.TTS_COMMAND || 'edge-tts', [
      '--voice', voice.name, '--rate=' + signed(voice.rate) + '%', '--pitch=' + signed(voice.pitch) + 'Hz',
      '--text=' + lines.join(language === 'zh' ? '' : ' '), '--write-media', original, '--write-subtitles', srt, '--no-progress',
    ], {signal, timeout: 65_000});
  } catch {
    signal.throwIfAborted();
    throw new Fault('TTS_FAILED', 'Edge TTS did not return speech', {retryable: true});
  }
  const pcm = await decode(original, work, signal);
  const timing = alignSpeech(lines, await readFile(srt, 'utf8'), pcm.length / (2 * sampleRate));
  const stop = Math.min(pcm.length / 2, Math.ceil((timing.at(-1).end + 0.32) * sampleRate));
  const buffers = [];
  const captions = [];
  let from = 0;
  let added = 0;
  for (const [index, segment] of segments.entries()) {
    const {start, end} = timing[index];
    const next = timing[index + 1]?.start;
    const naturalGap = next === undefined ? 0 : 1000 * Math.max(0, next - end);
    const extra = segment.pauseMs > 300 ? Math.max(0, segment.pauseMs - 270 - naturalGap) : 0;
    const to = next === undefined ? stop : Math.min(stop, Math.round((end + Math.max(0, next - end) * 0.5) * sampleRate));
    buffers.push(pcm.subarray(from * 2, to * 2));
    captions.push({start: start + added / sampleRate, end: end + added / sampleRate, text: segment.text, cue: segment.cue});
    const gap = pause(extra);
    if (gap.length) buffers.push(gap);
    added += gap.length / 2;
    from = to;
  }
  return {pcm: Buffer.concat(buffers), captions, hasSpeech: true};
}

async function fixtureSpeech(segments, voice, work, signal) {
  const buffers = [];
  const captions = [];
  let samples = 0;
  let hasSpeech = false;
  for (const segment of segments) {
    const text = segment.speak || segment.text;
    const index = fixtureLines.indexOf(text);
    const recorded = index >= 0;
    let pcm;
    if (recorded) {
      const name = (voice.name === 'zh-CN-YunxiNeural' ? 'yunxi-' : 'voice-') + (index + 1) + '.mp3';
      pcm = await decode(fileURLToPath(new URL('../../fixtures/' + name, import.meta.url)), work, signal);
    } else {
      pcm = pause(Math.max(850, Math.min(12_000, text.length * 145)));
    }
    const silence = pause(segment.pauseMs);
    const end = samples + pcm.length / 2;
    captions.push({start: samples / sampleRate, end: end / sampleRate, cue: segment.cue, text: segment.text});
    buffers.push(pcm, silence);
    samples = end + silence.length / 2;
    hasSpeech ||= recorded;
  }
  return {pcm: Buffer.concat(buffers), captions, hasSpeech};
}

export async function synthesize(job, id, signal) {
  const dir = sceneDir(job, id);
  const timingFile = join(dir, 'timing.json');
  if (await maybe(timingFile)) {
    const [{durationFrames}, {options}] = await Promise.all([read(timingFile), read(join(projectDir(job.projectId), 'input.json'))]);
    requireSceneDuration(options, durationFrames);
    return durationFrames;
  }
  const [script, direction, {options}, request] = await Promise.all([
    read(join(dir, 'script.json')), read(join(revisionDir(job), 'voice.json')),
    read(join(projectDir(job.projectId), 'input.json')), read(join(revisionDir(job), 'request.json')),
  ]);
  const style = request.sound?.voiceStyle ?? options.voiceStyle;
  const voice = configuredVoice(options.language, style, direction);
  const narration = options.narration !== false;
  const key = [3, fixture, script.segments, voice, ...(narration ? [] : ['silent'])];
  const audio = join(projectDir(job.projectId), 'cache', 'audio', hash(key) + '.wav');
  const timing = await cached(job, 'audio', key, async () => {
    if (!narration) {
      const durationFrames = Math.min(sceneFrameLimit(options), 6 * FPS + (script.segments.length - 1) * 2 * FPS);
      const cues = Object.fromEntries(script.segments.map(({cue}, index) =>
        [cue, Math.round((index + 0.5) * durationFrames / (script.segments.length + 1))]));
      await atomic(audio, wav(Buffer.alloc(durationFrames * samplesPerFrame * 2)));
      return {durationFrames, fps: FPS, cues, captions: [], voice: null, hasSpeech: false};
    }
    const work = await mkdtemp(join(tmpdir(), 'knovid-voice-'));
    try {
      const {pcm, captions: phrases, hasSpeech} = fixture ?
        await fixtureSpeech(script.segments, voice, work, signal) : await liveSpeech(script.segments, voice, options.language, work, signal);
      const lead = 0.24;
      const samples = pcm.length / 2 + Math.round(lead * sampleRate);
      const frames = Math.max(40, Math.ceil((samples + sampleRate * 0.2) / samplesPerFrame));
      if (frames > 60 * FPS) throw new Fault('SCENE_TOO_LONG', 'Keep each scene shorter than 60 seconds');
      requireSceneDuration(options, frames);
      const cues = Object.fromEntries(phrases.map(phrase => [phrase.cue, Math.round((lead + phrase.start) * FPS)]));
      const captions = phrases.map(({text, start, end}) => ({
        text: cleanLine(text), start: lead + start, end: Math.max(lead + start + 0.04, lead + end),
      }));
      await atomic(audio, wav(Buffer.concat([pause(lead * 1000), pcm, Buffer.alloc((frames * samplesPerFrame - samples) * 2)])));
      const voiceName = fixture ? (voice.name === 'zh-CN-YunxiNeural' ? voice.name : 'macOS Tingting fixture') : voice.name;
      return {durationFrames: frames, fps: FPS, cues, captions, voice: hasSpeech ? voiceName : null, hasSpeech};
    } finally {
      await rm(work, {recursive: true, force: true});
    }
  });
  requireSceneDuration(options, timing.durationFrames);
  await share(audio, join(dir, 'audio.wav'));
  await json(timingFile, timing);
  return timing.durationFrames;
}
