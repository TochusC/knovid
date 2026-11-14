import {isIP} from 'node:net';

const userAgent = 'KnoVid/0.1 (+https://knovid.art/)';
const maxResponseBytes = 384 * 1024;
const resultCount = 6;

async function readSearchResponse(response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Search provider returned HTTP ' + response.status);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) throw new Error('Search response was too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function plainText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit * 4).replace(/<[^>]*>/g, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function normalizeResults(results) {
  if (!Array.isArray(results)) throw new Error('Invalid search response');
  const hits = new Map();
  for (const result of results) {
    if (typeof result?.url !== 'string' || result.url.length > 2500) continue;
    let url;
    try {
      url = new URL(result.url.trim());
    } catch {
      continue;
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
        !url.hostname.includes('.') || isIP(url.hostname)) continue;
    url.hash = '';
    if (hits.has(url.href)) continue;
    hits.set(url.href, {
      title: plainText(result.title, 240) || url.hostname,
      url: url.href,
      snippet: plainText(result.snippet ?? result.content, 600),
    });
    if (hits.size === resultCount) break;
  }
  return [...hits.values()];
}

function deadline(signal) {
  const timeout = AbortSignal.timeout(10_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function postSearch(url, query, headers, options, signal) {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: deadline(signal),
    headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgent, ...headers},
    body: JSON.stringify({query, max_results: resultCount, ...options}),
  });
  return normalizeResults((await readSearchResponse(response))?.results);
}

function tavily(query, key, signal) {
  const headers = key ? {Authorization: 'Bearer ' + key} : {'X-Tavily-Access-Mode': 'keyless'};
  return postSearch('https://api.tavily.com/search', query, headers,
    {search_depth: 'basic', include_answer: false, include_raw_content: false}, signal);
}

function keenable(query, signal) {
  return postSearch('https://api.keenable.ai/v1/search/public', query, {'X-Keenable-Title': 'KnoVid'},
    {snippet_max_length: 900}, signal);
}

async function searxng(endpoint, query, language, signal) {
  const url = new URL(endpoint);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid SearXNG endpoint');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', language === 'zh' ? 'zh-CN' : 'en');
  const response = await fetch(url, {
    redirect: 'error', signal: deadline(signal), headers: {Accept: 'application/json', 'User-Agent': userAgent},
  });
  const payload = await readSearchResponse(response);
  const results = normalizeResults(payload?.results);
  if (!results.length && payload.unresponsive_engines?.length) throw new Error('SearXNG engines did not return results');
  return results;
}

export async function searchWeb(query, language, signal) {
  signal?.throwIfAborted();
  const text = query.trim().slice(0, 300);
  if (!text) return [];
  const key = process.env.TAVILY_API_KEY?.trim();
  const endpoint = process.env.SEARXNG_SEARCH_URL?.trim();
  const providers = [];
  if (key) providers.push(() => tavily(text, key, signal));
  if (endpoint) providers.push(() => searxng(endpoint, text, language, signal));
  providers.push(() => keenable(text, signal));
  if (!key) providers.push(() => tavily(text, undefined, signal));
  let available = false;
  let failure;
  for (const search of providers) {
    signal?.throwIfAborted();
    try {
      const results = await search();
      if (results.length) return results;
      available = true;
    } catch (error) {
      signal?.throwIfAborted();
      failure = error;
    }
  }
  if (available) return [];
  throw new Error('Web search providers could not complete the request', {cause: failure});
}
