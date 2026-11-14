import {Fault, record, UUID} from './common.mjs';
import {soundSettings} from './sound.mjs';
import {guestSceneCount, maxSceneCount, minSceneCount} from './scene-limits.mjs';
import {isBuiltinStyleId} from './builtin-styles.mjs';
import {isModelId} from './model-catalog.mjs';
import {publicWebURL} from './web-source.mjs';

const customStyleId = new RegExp('^' + UUID + '$');
const referenceLimit = 8;
const topicInputLimit = 17_000;

function invalid(message) {
  throw new Fault('INVALID_INPUT', message, {status: 400});
}

export function publicReferenceURL(value, label = 'input.url') {
  try {
    return publicWebURL(value);
  } catch {
    invalid(label + ' must be a public HTTP or HTTPS URL without credentials or a custom port');
  }
}

export function supportedPaperURL(value) {
  const url = publicReferenceURL(value);
  if (['arxiv.org', 'export.arxiv.org'].includes(url.hostname)) {
    const match = /^\/(?:abs|pdf)\/((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?)(?:\.pdf)?\/?$/u.exec(url.pathname);
    if (match) return 'https://arxiv.org/pdf/' + match[1];
  }
  if (url.hostname === 'openreview.net' && ['/forum', '/pdf'].includes(url.pathname)) {
    const id = url.searchParams.get('id');
    if (/^[A-Za-z0-9_-]{1,100}$/.test(id || '')) return 'https://openreview.net/pdf?id=' + id;
  }
  if (url.hostname === 'aclanthology.org' && /^\/[\w.-]{2,100}(?:\/)?$/.test(url.pathname) && !url.pathname.includes('..')) {
    return 'https://aclanthology.org' + url.pathname.replace(/\/$/, '').replace(/\.pdf$/, '') + '.pdf';
  }
  return url.href;
}

function inlineReferences(topic, strict = false) {
  const references = [];
  let title = '';
  let last = 0;
  const pattern = /(?:\[([^\[\]\r\n]{0,300})\]\(\s*<?|<)?(https?:\/\/[^\s<>"'`，。！？；、（）【】「」《》]+)/giu;
  for (const match of topic.matchAll(pattern)) {
    const [raw, label, candidate] = match;
    const start = match.index;
    let parentheses = 0;
    let brackets = 0;
    let length = 0;
    for (const character of candidate) {
      if (character === '(') parentheses++;
      if (character === ')' && --parentheses < 0) break;
      if (character === '[') brackets++;
      if (character === ']' && --brackets < 0) break;
      length += character.length;
    }
    const value = candidate.slice(0, length).replace(/[.,;:!?]+$/, '');
    let url;
    try { url = publicWebURL(value); } catch {
      if (strict) invalid('input.referenceUrls must contain only public HTTP or HTTPS URLs');
      continue;
    }
    references.push(url.href);
    let end = start + raw.length - candidate.length + value.length;
    const markdownEnd = label !== undefined && /^>?[ \t]*(?:["'][^\r\n]*?["'][ \t]*)?\)/u.exec(topic.slice(end));
    if (markdownEnd) end += markdownEnd[0].length;
    else if (raw.startsWith('<') && topic[end] === '>') end++;
    title += topic.slice(last, start) + (markdownEnd && !/^https?:\/\//i.test(label) ? label : '');
    last = end;
  }
  title += topic.slice(last);
  return {references, title};
}

export function referenceUrlsInTopic(topic) {
  return [...new Set(inlineReferences(topic).references)].slice(0, referenceLimit);
}

function topicSource(input) {
  const topic = textField(input.topic, 'input.topic', topicInputLimit);
  const {references, title} = inlineReferences(topic, true);
  const supplied = input.referenceUrls ?? [];
  if (!Array.isArray(supplied) || supplied.length > referenceLimit) {
    invalid('input.referenceUrls must contain at most ' + referenceLimit + ' URLs');
  }
  const referenceUrls = [...new Set([...references, ...supplied.map(value => publicReferenceURL(value, 'input.referenceUrls').href)])];
  if (referenceUrls.length > referenceLimit) invalid('input.referenceUrls must contain at most ' + referenceLimit + ' URLs');
  const label = references.length ? title.trim()
    .replace(/(?:[\s，。；;,:：]+|^)(?:参考(?:网址|链接|资料)?|reference(?:s| links?)?|sources?)\s*[:：]?\s*$/iu, '')
    .replace(/[\s，。；;,:：]+$/, '') || new URL(referenceUrls[0]).hostname : title;
  return {type: 'topic', title: textField(label, 'input.topic', 300), sources: sourceList(input.sources),
    ...(referenceUrls.length && {referenceUrls})};
}

export function textField(value, label, max, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    invalid(label + ' must contain ' + min + '–' + max + ' characters');
  }
  return value.trim();
}

function sourceList(sources = []) {
  if (!Array.isArray(sources) || sources.length > 12) invalid('sources must contain at most 12 entries');
  return sources.map((source, index) => {
    if (!record(source)) invalid('Invalid source at index ' + index);
    const result = {
      title: textField(source.title, 'sources.title', 200),
      excerpt: textField(source.excerpt, 'sources.excerpt', 1600),
    };
    if (source.url !== undefined) {
      try {
        const url = new URL(textField(source.url, 'sources.url', 500));
        if (url.protocol !== 'https:' || url.username || url.password) invalid('Invalid source URL');
        result.url = url.href;
      } catch {
        invalid('sources.url must be an HTTPS link');
      }
    }
    return result;
  });
}

export function creation(body, pdfBuffer) {
  if (!record(body)) invalid('Expected a JSON object');
  const {input = {}, options = {}} = body;
  if (!record(input) || !record(options)) invalid('input and options must be objects');
  const language = options.language ?? 'zh';
  const sceneCount = options.sceneCount ?? guestSceneCount;
  const size = options.size ?? '1080p';
  const modelProvider = options.modelProvider ?? 'standard';
  if (!isModelId(modelProvider)) invalid('Unknown model provider');
  if (options.visualMode !== undefined && !['auto', 'animation', 'footage'].includes(options.visualMode)) {
    invalid('options.visualMode must be auto, animation or footage');
  }
  if (options.narration !== undefined && typeof options.narration !== 'boolean') invalid('options.narration must be a boolean');
  if (options.stylePresetId !== undefined && (typeof options.stylePresetId !== 'string' ||
    !(isBuiltinStyleId(options.stylePresetId) || options.stylePresetId === 'auto' || customStyleId.test(options.stylePresetId)))) {
    invalid('Invalid style selection');
  }
  if (!['zh', 'en'].includes(language)) invalid('options.language must be zh or en');
  if (!Number.isInteger(sceneCount) || sceneCount < minSceneCount || sceneCount > maxSceneCount) {
    invalid('options.sceneCount must be between ' + minSceneCount + ' and ' + maxSceneCount);
  }
  if (!['360p', '720p', '1080p'].includes(size)) invalid('options.size must be 360p, 720p or 1080p');
  if (options.music !== undefined && typeof options.music !== 'boolean') invalid('options.music must be a boolean');
  const sizes = {'360p': [640, 360], '720p': [1280, 720], '1080p': [1920, 1080]};
  let source;
  if (pdfBuffer) {
    if (!pdfBuffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      throw new Fault('INVALID_PDF', 'Upload must be a PDF document', {status: 400});
    }
    source = {type: 'pdf', title: textField(input.title || 'PDF', 'input.title', 200)};
  } else if (input.type === 'topic') {
    source = topicSource(input);
  } else if (input.type === 'paper-text') {
    source = {
      type: 'paper-text',
      title: textField(input.title, 'input.title', 200),
      text: textField(input.text, 'input.text', 100_000, 40),
    };
  } else if (input.type === 'paper-url') {
    source = {
      type: 'paper-url',
      url: supportedPaperURL(textField(input.url, 'input.url', 2048)),
      title: textField(input.title || 'Paper', 'input.title', 200),
    };
  } else {
    invalid('input.type must be topic, paper-text or paper-url. To upload a PDF, send application/pdf.');
  }
  const [width, height] = sizes[size];
  return {
    input: source,
    options: {language, sceneCount, width, height, music: options.music ?? true,
      ...(modelProvider !== 'standard' && {modelProvider}),
      ...(options.narration === false && {narration: false}),
      ...(options.stylePresetId !== undefined && {stylePresetId: options.stylePresetId}),
      ...(options.visualMode !== undefined && {visualMode: options.visualMode}),
      ...soundSettings(options, language)},
  };
}

export function patchScene(body, schema, language) {
  if (!record(body) || !body.baseRevisionId) invalid('baseRevisionId is required');
  const patch = {};
  if (body.narration !== undefined) {
    const narration = textField(body.narration, 'narration', language === 'zh' ? 320 : 1000);
    if (!/[\p{L}\p{N}]/u.test(narration)) invalid('narration must contain spoken words');
    patch.narration = narration;
  }
  if (body.params !== undefined) {
    if (!record(body.params)) invalid('params must be an object');
    patch.params = Object.fromEntries(Object.entries(body.params).map(([key, value]) => {
      if (!Object.hasOwn(schema, key)) invalid('Unknown scene parameter: ' + key);
      const spec = schema[key];
      if (typeof value !== spec.type || (spec.type === 'number' &&
        (!Number.isFinite(value) || value < spec.min || value > spec.max))) {
        invalid('Invalid value for scene parameter: ' + key);
      }
      return [key, value];
    }));
    if (Object.keys(patch.params).length === 0) delete patch.params;
  }
  if (Object.keys(patch).length === 0) invalid('Provide narration or params to change');
  return patch;
}
