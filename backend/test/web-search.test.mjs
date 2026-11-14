import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'knovid-web-search-'));
test.after(() => rm(root, {recursive: true, force: true}));
process.env.KNOVID_DATA = root;
process.env.KNOVID_MODE = 'live';
const {json, projectDir, read, revisionDir} = await import('../src/common.mjs');
const {acquire, extractText} = await import('../src/activities/research.mjs');
const {searchWeb} = await import('../src/web-search.mjs');

test('public search normalizes links and falls back when a provider is rate-limited', async t => {
  const savedKey = process.env.TAVILY_API_KEY;
  const savedEndpoint = process.env.SEARXNG_SEARCH_URL;
  t.after(() => {
    if (savedKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = savedKey;
    if (savedEndpoint === undefined) delete process.env.SEARXNG_SEARCH_URL;
    else process.env.SEARXNG_SEARCH_URL = savedEndpoint;
  });
  delete process.env.TAVILY_API_KEY;
  delete process.env.SEARXNG_SEARCH_URL;
  const calls = [];
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(input);
    calls.push(url.hostname);
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).query, '天津青年黑客松');
    if (url.hostname === 'api.keenable.ai') {
      assert.equal(options.headers['X-Keenable-Title'], 'KnoVid');
      return new Response(null, {status: 429});
    }
    assert.equal(options.headers['X-Tavily-Access-Mode'], 'keyless');
    return Response.json({results: [
      {url: 'https://bohack.top/#about', title: '<strong>BoHack</strong>', content: '天津\n青年黑客松'},
      {url: 'https://bohack.top/', title: 'Duplicate'},
      {url: 'https://login:password@example.com/', title: 'Credentials'},
      {url: 'http://127.0.0.1/', title: 'Loopback'},
      {url: 'file:///etc/passwd', title: 'File'},
    ]});
  });
  assert.deepEqual(await searchWeb(' 天津青年黑客松 ', 'zh'), [
    {title: 'BoHack', url: 'https://bohack.top/', snippet: '天津 青年黑客松'},
  ]);
  assert.deepEqual(calls, ['api.keenable.ai', 'api.tavily.com']);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchWeb('天津青年黑客松', 'zh', controller.signal), {name: 'AbortError'});
  assert.equal(calls.length, 2);
});

test('the research worker searches both generated phrases for a long brief and falls back to the title without them', async t => {
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.hostname.endsWith('.wikipedia.org')) {
      wikiQueries.push([url.hostname, url.searchParams.get('gsrsearch')]);
      return Response.json({query: {pages: {
        1: {index: 1, title: 'Map scale', canonicalurl: 'https://en.wikipedia.org/wiki/Scale_(map)', extract: 'A map scale relates distances on a map to corresponding distances on the ground. ' + 'It lets people compare routes and determine how far locations are from each other.'},
      }}});
    }
    searchQueries.push(options.body ? JSON.parse(options.body).query : url.searchParams.get('q'));
    return Response.json({results: []});
  });
  const searchQueries = [];
  const wikiQueries = [];
  const job = {projectId: 'long-brief', revisionId: 'with-queries'};
  const fallback = {...job, revisionId: 'without-queries'};
  const title = '创作说明';
  const queries = [{language: 'zh', query: '如何阅读比例尺'}, {language: 'en', query: 'Understanding map scale'}];
  await json(join(projectDir(job.projectId), 'input.json'), {
    input: {type: 'topic', title, brief: '请用地图动画解释比例尺。'.repeat(60)}, options: {language: 'zh'},
  });
  await json(join(revisionDir(job), 'search-queries.json'), {queries});

  const signal = new AbortController().signal;
  assert.equal(await acquire(job, signal), 'long-topic');
  await extractText(job, signal);
  assert.deepEqual([...new Set(searchQueries)].sort(), queries.map(({query}) => query).sort());
  assert.deepEqual(wikiQueries, [['zh.wikipedia.org', queries[0].query], ['en.wikipedia.org', queries[1].query]]);
  assert.equal((await read(join(revisionDir(job), 'sources.json'))).passages[0].title, 'Map scale');

  searchQueries.length = wikiQueries.length = 0;
  await extractText(fallback, signal);
  assert.deepEqual([...new Set(searchQueries)], [title]);
  assert.deepEqual(wikiQueries, [['zh.wikipedia.org', title], ['en.wikipedia.org', title]]);

  await json(join(projectDir(job.projectId), 'input.json'), {
    input: {type: 'topic', title, brief: '请用地图动画解释比例尺。'.repeat(60), referenceUrls: ['https://example.org/maps']},
    options: {language: 'zh'},
  });
  assert.equal(await acquire(job, signal), 'topic');
});
