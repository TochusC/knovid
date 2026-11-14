import assert from 'node:assert/strict';
import test from 'node:test';
import {searchWeb} from '../src/web-search.mjs';

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
