import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atomic, Fault, run} from '../common.mjs';
import {extractWebContent, fetchWebResource} from '../web-source.mjs';
import {searchWeb} from '../web-search.mjs';

const documentLimit = 20 * 1024 * 1024;
const accept = 'text/html, application/xhtml+xml, text/plain, application/pdf;q=0.9, */*;q=0.1';
const pdf = resource => resource.body.subarray(0, 1024).includes(Buffer.from('%PDF-'));

export function webPassages({title, url, text}, limit) {
  return text.trim().match(/[\s\S]{1,1200}/gu)?.slice(0, limit).flatMap(part => {
    const excerpt = part.replace(/\s+/gu, ' ').trim();
    return excerpt.length >= 35 ? [{title, url, excerpt}] : [];
  }) ?? [];
}

export async function acquireDocument(url, target, signal) {
  const resource = await fetchWebResource(url, signal, {maxBytes: documentLimit, accept, timeoutMs: 65_000});
  if (!pdf(resource)) return extractWebContent(resource, signal);
  await atomic(target, resource.body);
  return null;
}

async function readPassages(url, limit, signal) {
  const resource = await fetchWebResource(url, signal, {maxBytes: documentLimit, accept, timeoutMs: 15_000});
  if (!pdf(resource)) return webPassages(await extractWebContent(resource, signal), limit);
  const folder = await mkdtemp(join(tmpdir(), 'knovid-web-pdf-'));
  try {
    const file = join(folder, 'source.pdf');
    await atomic(file, resource.body);
    const {stdout} = await run('pdftotext', ['-f', '1', '-l', '8', file, '-'], {signal, timeout: 15_000});
    const path = new URL(resource.url).pathname;
    const title = path.split('/').filter(Boolean).at(-1) || new URL(resource.url).hostname;
    return webPassages({url: resource.url, title, text: stdout}, limit);
  } finally {
    await rm(folder, {recursive: true, force: true});
  }
}

export async function referencePassages(urls, limit, signal) {
  const passages = [];
  const seen = new Set();
  for (let offset = 0; offset < urls.length; offset += 3) {
    signal.throwIfAborted();
    const pages = await Promise.allSettled(urls.slice(offset, offset + 3).map(url => readPassages(url, limit, signal)));
    signal.throwIfAborted();
    for (const page of pages) {
      if (page.status !== 'fulfilled') continue;
      for (const passage of page.value) {
        const key = passage.url + '\n' + passage.excerpt;
        if (seen.has(key)) continue;
        seen.add(key);
        passages.push(passage);
      }
    }
  }
  return passages;
}

export async function searchPassages(queries, signal, extended = false) {
  const valid = queries.filter(({query}) => typeof query === 'string' && query.trim());
  if (!valid.length) return [];
  const batches = await Promise.allSettled(valid.map(({language, query}) => searchWeb(query, language, signal)));
  signal.throwIfAborted();
  if (batches.every(result => result.status === 'rejected')) {
    throw new Fault('SEARCH_UNAVAILABLE', 'Public web search is temporarily unavailable', {retryable: true});
  }
  const results = batches.flatMap(batch => batch.status === 'fulfilled' ? batch.value : []);
  const urls = [...new Set(results.map(result => result.url))].slice(0, extended ? 8 : 5);
  return referencePassages(urls, extended ? 5 : 3, signal);
}
