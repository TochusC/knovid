import {Fault, record} from './common.mjs';
import {soundSettings} from './sound.mjs';
import {guestSceneCount, maxSceneCount, minSceneCount} from './scene-limits.mjs';

function invalid(message) {
  throw new Fault('INVALID_INPUT', message, {status: 400});
}

export function supportedPaperURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    invalid('input.url must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    invalid('Paper URLs must use HTTPS without credentials or a custom port');
  }
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
  invalid('Supported paper link hosts: arxiv.org, openreview.net and aclanthology.org. Other papers can be uploaded as PDF.');
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
  if (!['standard', 'deepseek', 'openrouter'].includes(modelProvider)) invalid('Unknown model provider');
  if (options.narration !== undefined && typeof options.narration !== 'boolean') invalid('options.narration must be a boolean');
  if (options.stylePresetId !== undefined &&
    (typeof options.stylePresetId !== 'string' || !/^(default|auto|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/u.test(options.stylePresetId))) {
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
    source = {type: 'topic', title: textField(input.topic, 'input.topic', 300), sources: sourceList(input.sources)};
  } else if (input.type === 'paper-text') {
    source = {
      type: 'paper-text',
      title: textField(input.title, 'input.title', 200),
      text: textField(input.text, 'input.text', 100_000, 40),
    };
  } else if (input.type === 'paper-url') {
    source = {
      type: 'paper-url',
      url: supportedPaperURL(textField(input.url, 'input.url', 500)),
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
