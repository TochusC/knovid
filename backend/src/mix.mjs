import {assetFile, catalog, credit} from './sound.mjs';
import {run} from './common.mjs';

export function designSound(scenes, fps, options) {
  const music = options.music && catalog.music.find(asset => asset.id ===
    (options.musicTrack === 'auto' || !options.musicTrack ?
      (scenes.length > 4 ? 'exploration' : 'first-light') : options.musicTrack));
  const effects = [];
  if (options.effects !== false) {
    let offset = 0;
    let last = -2;
    const add = (id, time, gain) => {
      if (time - last < 0.7) return;
      last = time;
      effects.push({id, time: Math.round(time * 1000) / 1000, gain});
    };
    for (const [index, scene] of scenes.entries()) {
      const {timing} = scene;
      const final = index === scenes.length - 1;
      const cues = Object.values(timing.cues).sort((a, b) => a - b);
      if (!index) add('transition', 0.03, -24);
      if (index && !final) add(index % 2 ? 'transition' : 'accent', Math.max(0, offset - 0.12), -27);
      const key = cues.length > 1 ? cues[1] : (index === 0 || final ? cues[0] : undefined);
      const latest = timing.durationFrames / fps - 0.2;
      if (key !== undefined && key / fps <= latest) {
        add(final ? 'resolve' : 'accent', offset + Math.min(latest, Math.max(0, key / fps + 0.47)), final ? -20 : -23);
      }
      offset += timing.durationFrames / fps;
    }
  }
  const used = new Set(effects.map(effect => effect.id));
  return {
    music: music ? credit(music) : null,
    effects,
    credits: [...(music ? [credit(music)] : []), ...catalog.effects.filter(item => used.has(item.id)).map(credit)],
  };
}

export async function mixVideo({visual, narration, target, duration, sound, signal, timeout = 180_000}) {
  const length = duration.toFixed(3);
  const args = ['-y', '-v', 'error', '-i', visual, '-i', narration];
  const filters = [
    '[1:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration=' + length + '[speech]',
  ];
  const mix = ['[speech]'];
  let next = 2;
  if (sound.music) {
    const item = catalog.music.find(item => item.id === sound.music.id);
    args.push('-stream_loop', '-1', '-i', assetFile(item));
    const fadeIn = Math.min(0.58, duration / 4);
    const fadeOut = Math.min(1.15, duration / 3);
    filters.push(
      '[speech]asplit=2[voice][key]',
      '[' + next++ + ':a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,atrim=duration=' + length +
        ',volume=-8dB,afade=t=in:d=' + fadeIn.toFixed(3) + ',afade=t=out:st=' + (duration - fadeOut).toFixed(3) +
        ':d=' + fadeOut.toFixed(3) + '[music]',
      '[music][key]sidechaincompress=threshold=0.025:ratio=7:attack=24:release=360[bed]',
    );
    mix.splice(0, 1, '[voice]', '[bed]');
  }
  for (const asset of catalog.effects) {
    const marks = sound.effects.filter(event => event.id === asset.id);
    if (!marks.length) continue;
    args.push('-i', assetFile(asset));
    const prefix = 'fx' + next;
    const input = '[' + next++ + ':a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS';
    if (marks.length > 1) {
      filters.push(input + ',asplit=' + marks.length + marks.map((_, i) => '[' + prefix + 'in' + i + ']').join(''));
    }
    for (const [i, mark] of marks.entries()) {
      const output = '[' + prefix + 'out' + i + ']';
      const source = marks.length > 1 ? '[' + prefix + 'in' + i + ']' : input + ',';
      filters.push(source + 'volume=' + mark.gain + 'dB,adelay=' + Math.round(mark.time * 1000) + ':all=1' + output);
      mix.push(output);
    }
  }
  const combine = mix.length > 1 ? 'amix=inputs=' + mix.length + ':duration=first:normalize=0,' : '';
  filters.push(mix.join('') + combine +
    'loudnorm=I=-16:TP=-2:LRA=8,aresample=48000:out_chlayout=stereo,alimiter=limit=0.80:level=false:latency=true,volume=-1.5dB[out]');
  args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[out]', '-c:v', 'copy',
    '-c:a', 'aac', '-ar', '48000', '-b:a', '160k', '-movflags', '+faststart', target);
  await run('ffmpeg', args, {signal, timeout});
}
