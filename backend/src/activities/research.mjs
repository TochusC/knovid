import {randomUUID} from 'node:crypto';
import {rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {atomic, Fault, fixture, json, maybe, projectDir, read, revisionDir, run} from '../common.mjs';
import {supportedPaperURL} from '../contracts.mjs';

const limit = 20 * 1024 * 1024;
const options = {
  redirect: 'manual',
  headers: {'User-Agent': 'KnoVid/0.1 (https://knovid.art/)'},
};
const whitespace = text => text.replace(/\s+/gu, ' ').trim();

async function downloadPDF(url, target, signal) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(70_000)]);
  let response;
  for (let redirect = 0; redirect < 4; redirect++) {
    response = await fetch(url, {...options, signal: requestSignal}).catch(() => {
      signal.throwIfAborted();
      throw new Fault('PAPER_UNAVAILABLE', 'Could not download the PDF', {retryable: true});
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = response.headers.get('location');
    await response.body?.cancel();
    if (!next) throw new Fault('PAPER_UNAVAILABLE', 'PDF host returned an invalid redirect');
    url = supportedPaperURL(new URL(next, url).href);
  }
  if (!response.ok || !response.body) {
    throw new Fault('PAPER_UNAVAILABLE', 'PDF host returned HTTP ' + response.status, {retryable: response.status >= 500});
  }
  const parts = [];
  let size = 0;
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > limit) throw new Fault('PDF_TOO_LARGE', 'PDF downloads are limited to 20 MiB');
    parts.push(bytes);
  }
  const contents = Buffer.concat(parts);
  if (!contents.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new Fault('INVALID_PDF', 'The paper URL did not return a PDF');
  }
  await atomic(target, contents);
}

async function wiki(language, topic, signal) {
  const endpoint = new URL('https://' + language + '.wikipedia.org/w/api.php');
  endpoint.search = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: topic, gsrlimit: '4',
    prop: 'extracts|info', exintro: '1', explaintext: '1', exchars: '1500', inprop: 'url',
  }).toString();
  const response = await fetch(endpoint, {...options, signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)])});
  if (!response.ok) throw new Error('Search unavailable');
  const payload = await response.json();
  return Object.values(payload.query?.pages || {}).sort((a, b) => a.index - b.index)
    .filter(page => typeof page.extract === 'string' && page.extract.length >= 100)
    .map(page => ({title: page.title, url: page.canonicalurl, excerpt: whitespace(page.extract).slice(0, 1500)}));
}

function pageCandidates(text, title, page) {
  const clean = whitespace(text);
  return (clean.match(/[\s\S]{1,1200}/gu) || []).slice(0, 5)
    .filter(excerpt => excerpt.length >= 35)
    .map(excerpt => ({title, page, excerpt}));
}

export async function acquire(job, signal) {
  const info = await read(join(projectDir(job.projectId), 'input.json'));
  const {input} = info;
  if (input.type === 'pdf' || input.type === 'paper-url') {
    const file = join(projectDir(job.projectId), 'paper.pdf');
    if (!(await maybe(file))) {
      if (!input.url) throw new Fault('PDF_MISSING', 'The uploaded PDF cannot be found');
      await downloadPDF(input.url, file, signal);
    }
  }
  return input.type;
}

export async function extractText(job, signal) {
  const {input, options: settings} = await read(join(projectDir(job.projectId), 'input.json'));
  const out = join(revisionDir(job), 'sources.json');
  if (await maybe(out)) return;
  let hits;
  let totalPages = null;
  let examinedPages = null;
  if (input.type === 'topic') {
    hits = input.sources;
    if (!hits.length && fixture) {
      hits = [{title: 'Kepler’s laws of planetary motion', excerpt: 'A planet orbits the Sun along an ellipse with the Sun at one focus. Its orbital speed increases as it approaches the Sun. The line from the Sun to a planet sweeps out equal areas in equal times.', url: 'https://science.nasa.gov/solar-system/orbits-and-keplers-laws/'}];
    }
    if (!hits.length) {
      try {
        hits = await wiki(settings.language, input.title, signal);
        if (!hits.length && settings.language === 'zh') hits = await wiki('en', input.title, signal);
      } catch {
        signal.throwIfAborted();
        throw new Fault('SEARCH_UNAVAILABLE', 'Topic search was unavailable. Submit source excerpts with the topic.', {retryable: true});
      }
    }
  } else if (input.type === 'paper-text') {
    hits = pageCandidates(input.text, input.title, null);
  } else {
    const pdf = join(projectDir(job.projectId), 'paper.pdf');
    const info = await run('pdfinfo', [pdf], {signal});
    totalPages = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]);
    if (!Number.isFinite(totalPages) || totalPages < 1) throw new Fault('INVALID_PDF', 'PDF has no readable page count');
    examinedPages = Math.min(totalPages, 18);
    const {stdout} = await run('pdftotext', ['-layout', '-f', '1', '-l', String(examinedPages), pdf, '-'], {signal});
    const pages = stdout.split('\f').slice(0, examinedPages);
    hits = pages.flatMap((text, i) => pageCandidates(text, input.title, i + 1));
    if (input.url) hits = hits.map(hit => ({...hit, url: input.url + '#page=' + hit.page}));
    if (!hits.length) throw new Fault('NO_PDF_TEXT', 'PDF has no extractable text. Upload an OCR-processed PDF or provide paper text.');
  }
  if (!hits.length) throw new Fault('NO_SOURCES', 'No source passages found. Submit source excerpts with the topic.');
  await json(out, {title: input.title, totalPages, examinedPages, passages: hits.map((hit, i) => ({id: 'p' + (i + 1), ...hit}))});
}

export async function extractFigures(job, signal) {
  const {input} = await read(join(projectDir(job.projectId), 'input.json'));
  const dir = revisionDir(job);
  const target = join(dir, 'figures.json');
  if (await maybe(target)) return;
  if (!['pdf', 'paper-url'].includes(input.type)) {
    await json(target, []);
    return;
  }
  const pdf = join(projectDir(job.projectId), 'paper.pdf');
  const {stdout} = await run('pdftotext', ['-layout', '-l', '18', pdf, '-'], {signal});
  const figures = stdout.split('\f').flatMap((text, i) => text.split('\n').flatMap(line => {
    const caption = /^\s*((?:Fig(?:ure)?\.?\s*|Table\s*|图\s*|表\s*)\d+(?:[.-]\d+)?)[\s:：.]+(.+)$/iu.exec(line);
    return caption ? [{page: i + 1, label: caption[1], caption: whitespace(caption[2]).slice(0, 260)}] : [];
  })).slice(0, 20);
  const pages = [...new Set(figures.map(figure => figure.page))].slice(0, 4);
  await Promise.all(pages.map(async page => {
    const name = 'paper-page-' + page;
    const path = join(dir, name);
    if (!(await maybe(path + '.png'))) {
      const temporary = path + '-' + randomUUID();
      try {
        await run('pdftoppm', ['-f', String(page), '-l', String(page), '-r', '90', '-singlefile', '-png', pdf, temporary], {signal});
        await rename(temporary + '.png', path + '.png');
      } finally {
        await rm(temporary + '.png', {force: true});
      }
    }
  }));
  await json(target, figures.map(figure => pages.includes(figure.page) ? {...figure, artifact: 'paper-page-' + figure.page + '.png'} : figure));
}
