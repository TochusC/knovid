import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Fault, record} from './common.mjs';

const location = new URL('../assets/sound/', import.meta.url);
export const catalog = JSON.parse(readFileSync(new URL('catalog.json', location), 'utf8'));
export const tracks = catalog.music.map(item => item.id);
export const assetFile = item => fileURLToPath(new URL(item.file, location));
export const credit = ({file: _file, ...metadata}) => metadata;

export const voices = {
  zh: [
    {id: 'warm', name: '云希', voice: 'zh-CN-YunxiNeural', rate: -3},
    {id: 'soft', name: '晓晓', voice: 'zh-CN-XiaoxiaoNeural', rate: -2},
    {id: 'bright', name: '晓伊', voice: 'zh-CN-XiaoyiNeural', rate: -4},
    {id: 'steady', name: '云扬', voice: 'zh-CN-YunyangNeural', rate: -1},
  ],
  en: [
    {id: 'warm', name: 'Aria', voice: 'en-US-AriaNeural', rate: -1},
    {id: 'steady', name: 'Guy', voice: 'en-US-GuyNeural', rate: -2},
  ],
};
export const publicSound = () => ({
  voices,
  music: catalog.music.map(credit), effects: catalog.effects.map(credit),
});

export function soundSettings(body, language, patch = false) {
  if (!record(body)) throw new Fault('INVALID_INPUT', 'sound must be an object', {status: 400});
  const options = patch ? {} : {effects: true, musicTrack: 'auto', voiceStyle: 'warm'};
  if (body.effects !== undefined) {
    if (typeof body.effects !== 'boolean') throw new Fault('INVALID_INPUT', 'effects must be a boolean', {status: 400});
    options.effects = body.effects;
  }
  if (body.musicTrack !== undefined) {
    if (!['auto', ...tracks].includes(body.musicTrack)) throw new Fault('INVALID_INPUT', 'Unknown musicTrack', {status: 400});
    options.musicTrack = body.musicTrack;
  }
  if (body.voiceStyle !== undefined) {
    if (!voices[language].some(voice => voice.id === body.voiceStyle)) throw new Fault('INVALID_INPUT', 'Unknown voiceStyle for this language', {status: 400});
    options.voiceStyle = body.voiceStyle;
  }
  return options;
}

export function configuredVoice(language, style, direction) {
  const choices = voices[language];
  const selected = choices.find(item => item.id === style) || choices[0];
  const env = process.env['TTS_VOICE_' + language.toUpperCase()];
  const rate = Math.min(8, Math.max(-12, selected.rate + direction.rate));
  const pitch = Math.min(4, Math.max(-4, direction.pitch));
  return {name: (selected.id === choices[0].id && env) || selected.voice, rate, pitch};
}
