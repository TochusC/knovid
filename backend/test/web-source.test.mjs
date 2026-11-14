import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import {EventEmitter} from 'node:events';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {Readable} from 'node:stream';
import test from 'node:test';
import {gzipSync} from 'node:zlib';
import {extractWebContent, fetchWebResource, isPublicAddress, publicWebURL} from '../src/web-source.mjs';

test('public reference URLs reject private, reserved, tunneled and non-web destinations', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '100.100.100.200', '169.254.169.254', '168.63.129.16',
    '172.16.0.1', '198.18.0.1', '224.1.2.3', '::1', 'fe80::1', 'fd12::1', '::ffff:127.0.0.1',
    '64:ff9b::a00:1', '2002:7f00:1::', '2001:db8::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const url of ['file:///etc/passwd', 'https://user:pass@bohack.top/', 'https://bohack.top:22/',
    'http://0x7f000001/', 'http://127.1/', 'http://[::ffff:7f00:1]/', 'http://metadata.google.internal/',
    'http://foo.local./', 'http://postgres/']) {
    assert.throws(() => publicWebURL(url), {code: 'INVALID_SOURCE_URL'}, url);
  }
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('[2606:4700:4700::1111]'), true);
  assert.equal(publicWebURL('https://bohack.top:443/?page=3#section').href, 'https://bohack.top/?page=3');
});

test('web retrieval pins each checked host and rejects private redirects before connecting', async t => {
  const requested = [];
  const names = [];
  t.mock.method(dns, 'lookup', async (hostname, options) => {
    assert.deepEqual(options, {all: true});
    names.push(hostname);
    return hostname === 'private.example.org' ? [{address: '1.1.1.1', family: 4}, {address: '169.254.169.254', family: 4}]
      : [{address: '1.1.1.1', family: 4}];
  });
  const repeated = Buffer.alloc(300, 'a');
  t.mock.method(https, 'request', (url, options, callback) => {
    requested.push(url.href);
    assert.equal(options.agent, false);
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, '1.1.1.1');
      assert.equal(family, 4);
    });
    const req = new EventEmitter();
    req.end = () => {
      const redirect = url.pathname === '/unsafe';
      const compressed = url.pathname === '/gzip';
      const response = Readable.from([compressed ? gzipSync(repeated) : Buffer.from('valid body')]);
      response.statusCode = redirect ? 302 : 200;
      response.headers = redirect ? {location: 'https://private.example.org/secret'} : {'content-type': 'text/plain'};
      if (compressed) response.headers['content-encoding'] = 'gzip';
      callback(response);
    };
    return req;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await fetchWebResource('https://public.example.org/ok'), {
      url: 'https://public.example.org/ok', contentType: 'text/plain', body: Buffer.from('valid body'),
    });
    await assert.rejects(fetchWebResource('https://public.example.org/ok', undefined, {maxBytes: 5}), {code: 'WEB_SOURCE_TOO_LARGE'});
    await assert.rejects(fetchWebResource('https://public.example.org/unsafe'), {code: 'INVALID_SOURCE_URL'});
    assert.deepEqual((await fetchWebResource('https://public.example.org/gzip')).body, repeated);
    await assert.rejects(fetchWebResource('https://public.example.org/gzip', undefined, {maxBytes: 200}), {code: 'WEB_SOURCE_TOO_LARGE'});
    assert.deepEqual(names, ['public.example.org', 'public.example.org', 'public.example.org', 'private.example.org', 'public.example.org', 'public.example.org']);
    assert.deepEqual(requested, ['https://public.example.org/ok', 'https://public.example.org/ok', 'https://public.example.org/unsafe',
      'https://public.example.org/gzip', 'https://public.example.org/gzip']);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('HTML extraction retains source headings, paragraphs and Unicode characters while skipping hidden text', async () => {
  const title = 'BoHack & 天津青年黑客松';
  const first = '一场限时创造活动。参赛者在周末组队、开发和展示原型。';
  const second = 'The event brings designers, developers, and other participants together to build projects over a weekend.';
  const third = 'The final program includes project demonstrations, public talks, and a closing presentation for participants.';
  const html = `<html><head><title>BoHack &amp; 天津青年黑客松</title></head><body>
    <nav>Discard nav</nav><main><h1>日新 Renew.</h1><p>${first}</p><p>${second}</p><p>${third}</p>
    <script>Discard script</script><p aria-hidden="true">Discard aria</p><p style="display: none">Discard style</p>
    <template><p>Discard template</p></template></main><footer>Discard footer</footer></body></html>`;
  const result = await extractWebContent({url: 'https://bohack.top/', contentType: 'text/html', body: Buffer.from(html)});
  assert.deepEqual(result, {title, url: 'https://bohack.top/', text: ['日新 Renew.', first, second, third].join('\n')});
  await assert.rejects(extractWebContent({url: 'https://bohack.top/', contentType: 'text/html',
    body: Buffer.from('<title>Loading</title><div id="app"></div><script src="index.js"></script>')}), {code: 'WEB_SOURCE_UNREADABLE'});
});
