import {spawn} from 'node:child_process';
import {lookup} from 'node:dns/promises';
import {addAbortListener} from 'node:events';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {BlockList, isIP} from 'node:net';
import {promisify} from 'node:util';
import {brotliDecompress, gunzip, inflate} from 'node:zlib';
import {Fault} from './common.mjs';

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ['168.63.129.16', 32], // Azure host platform address
]) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(network, prefix, 'ipv6');
}
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
const redirectCodes = new Set([301, 302, 303, 307, 308]);
const webAccept = 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1';
const decompressors = new Map([['gzip', promisify(gunzip)], ['br', promisify(brotliDecompress)], ['deflate', promisify(inflate)]]);
const maxTextLength = 64_000;

const hostAddress = address => address.replace(/^\[|\]$/g, '');
const invalidURL = () => new Fault('INVALID_SOURCE_URL', 'Reference URLs must point to a public HTTP or HTTPS website');
const unavailable = () => new Fault('WEB_SOURCE_UNAVAILABLE', 'Could not read the reference website');
const unreadable = () => new Fault('WEB_SOURCE_UNREADABLE', 'The reference did not contain readable webpage text');
const tooLarge = () => new Fault('WEB_SOURCE_TOO_LARGE', 'The reference exceeded the download size limit');

export function isPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const ip = hostAddress(address);
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  return family === 6 && globalIPv6.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');
}

export function publicWebURL(input) {
  if ((typeof input !== 'string' && !(input instanceof URL)) || String(input).length > 2048) throw invalidURL();
  let url;
  try {
    url = new URL(input);
  } catch {
    throw invalidURL();
  }
  const host = hostAddress(url.hostname).toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !host || url.href.length > 2048) {
    throw invalidURL();
  }
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw invalidURL();
  } else if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home\.arpa|test|invalid|example|onion)$/.test(host)) {
    throw invalidURL();
  }
  url.hash = '';
  return url;
}

async function publicDNS(host, signal) {
  signal.throwIfAborted();
  if (isIP(host)) return {address: host, family: isIP(host)};
  let listener;
  try {
    const aborted = new Promise((_, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason));
    });
    const addresses = await Promise.race([lookup(host, {all: true}), aborted]);
    if (!addresses.length || addresses.some(({address}) => !isPublicAddress(address))) throw invalidURL();
    return addresses.find(({family}) => family === 4) ?? addresses[0];
  } finally {
    listener?.[Symbol.dispose]();
  }
}

async function requestWeb(url, signal, accept) {
  const host = hostAddress(url.hostname);
  const {address, family} = await publicDNS(host, signal);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    // Keep the URL hostname for the Host header and TLS verification. Every
    // socket uses the checked address, so the DNS answer cannot change after validation.
    const req = request(url, {
      family, autoSelectFamily: false, agent: false, signal, maxHeaderSize: 32 * 1024,
      lookup: (_host, options, callback) => options.all ? callback(null, [{address, family}]) : callback(null, address, family),
      headers: {'User-Agent': 'KnoVid/0.1 (https://knovid.art/)', Accept: accept, 'Accept-Encoding': 'gzip, br, deflate'},
    }, resolve);
    req.once('error', reject);
    req.end();
  });
}

export async function fetchWebResource(input, signal, {maxBytes = 2 * 1024 * 1024, accept = webAccept, timeoutMs = 15_000} = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = publicWebURL(input);
  try {
    for (let hop = 0; hop < 5; hop++) {
      const response = await requestWeb(url, requestSignal, accept);
      try {
        if (redirectCodes.has(response.statusCode) && response.headers.location) {
          url = publicWebURL(new URL(response.headers.location, url));
          continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) throw unavailable();
        const encoding = response.headers['content-encoding']?.trim().toLowerCase();
        const decompress = decompressors.get(encoding);
        if (encoding && encoding !== 'identity' && !decompress) throw unavailable();
        if (Number(response.headers['content-length']) > maxBytes) throw tooLarge();
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw tooLarge();
          chunks.push(chunk);
        }
        let body = Buffer.concat(chunks, bytes);
        if (decompress) {
          try {
            body = await decompress(body, {maxOutputLength: maxBytes});
          } catch (error) {
            if (error.code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge();
            throw error;
          }
        }
        requestSignal.throwIfAborted();
        return {url: url.href, contentType: response.headers['content-type'] ?? '', body};
      } finally {
        response.destroy();
      }
    }
    throw unavailable();
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Fault) throw error;
    throw unavailable();
  }
}

// The parser only reads markup supplied on stdin. It executes no script,
// loads no page resources, and ignores common invisible and navigation elements.
const readableHTML = String.raw`
import json, re, sys
from html.parser import HTMLParser

MAX_TEXT = 64000
BLOCKS = set('address article blockquote br caption dd details div dl dt figcaption figure h1 h2 h3 h4 h5 h6 header hr li main ol p pre section summary table tbody td th thead tr ul'.split())
SKIP = set('aside canvas dialog footer iframe nav noscript script select style svg template'.split())
VOID = set('area base br col embed hr img input link meta param source track wbr'.split())

class TextBuffer:
    def __init__(self, limit=MAX_TEXT):
        self.parts = []
        self.remaining = limit

    def add(self, data):
        if self.remaining and data:
            self.parts.append(data[:self.remaining])
            self.remaining -= min(self.remaining, len(data))

    def text(self):
        raw = ''.join(self.parts)
        return '\n'.join(line for part in raw.split('\n') if (line := ' '.join(part.split())))

class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.positions = {}
        self.hidden = self.main = 0
        self.title, self.heading = TextBuffer(300), TextBuffer(300)
        self.description = self.social_title = ''
        self.body, self.primary = TextBuffer(), TextBuffer()

    def write(self, data):
        self.body.add(data)
        if self.main:
            self.primary.add(data)

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == 'meta':
            name = (attributes.get('property') or attributes.get('name') or '').lower()
            value = ' '.join((attributes.get('content') or '').split())
            if not self.social_title and name == 'og:title':
                self.social_title = value[:300]
            if not self.description and name in ('description', 'og:description'):
                self.description = value[:1000]
        hidden = tag in SKIP or 'hidden' in attributes or (attributes.get('aria-hidden') or '').lower() == 'true'
        style = attributes.get('style') or ''
        hidden = hidden or bool(re.search(r'(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b', style, re.I))
        primary = tag in ('main', 'article') or attributes.get('role') == 'main'
        if tag in BLOCKS and not (self.hidden or hidden):
            self.write('\n')
        if tag in VOID:
            return
        self.positions.setdefault(tag, []).append(len(self.stack))
        self.stack.append((tag, hidden, primary))
        self.hidden += hidden
        self.main += primary

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        positions = self.positions.get(tag)
        if not positions:
            return
        if tag in BLOCKS and not self.hidden:
            self.write('\n')
        start = positions[-1]
        while len(self.stack) > start:
            name, hidden, primary = self.stack.pop()
            self.positions[name].pop()
            self.hidden -= hidden
            self.main -= primary

    def handle_data(self, data):
        if self.hidden:
            return
        if self.positions.get('title'):
            self.title.add(data)
            return
        if self.positions.get('head'):
            return
        self.write(data)
        if self.positions.get('h1'):
            self.heading.add(data)

page = Page()
page.feed(sys.stdin.buffer.read().decode('utf-8'))
page.close()
primary = page.primary.text()
body = primary if len(primary) >= 160 else page.body.text()
title = page.title.text() or page.social_title or page.heading.text()
if 0 < len(body) < 160 and page.description and page.description not in body:
    body = body + '\n' + page.description
print(json.dumps({'title': ' '.join(title.split()), 'text': body}, ensure_ascii=False), flush=True)
`;

async function parseHTML(html, signal) {
  const timeout = AbortSignal.timeout(5000);
  const parserSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', '-X', 'utf8', '-c', readableHTML], {
      signal: parserSignal, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(unreadable());
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(unreadable());
      }
    });
    child.stdin.end(html, 'utf8');
  });
}

export async function extractWebContent({url, contentType, body}, signal) {
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  const sample = body.subarray(0, 8192).toString('latin1');
  const looksLikeHTML = /<(?:!doctype\s+html\b|html\b|head\b|body\b|main\b|article\b|title\b|meta\b|div\b|p\b)/i.test(sample);
  const html = ['text/html', 'application/xhtml+xml'].includes(mime) || ((!mime || mime === 'application/octet-stream') && looksLikeHTML);
  if (!html && mime !== 'text/plain') throw unreadable();
  const headerCharset = /(?:^|;)\s*charset\s*=\s*["']?([\w.-]+)/i.exec(contentType)?.[1];
  const metaCharset = html ? /<meta\b[^>]{0,400}\bcharset\s*=\s*["']?([\w.-]+)/i.exec(sample)?.[1] : null;
  let decoded;
  try {
    decoded = new TextDecoder(headerCharset ?? metaCharset ?? 'utf-8').decode(body);
  } catch {
    throw unreadable();
  }
  let result;
  try {
    result = html ? await parseHTML(decoded, signal) : {text: decoded.slice(0, maxTextLength).trim()};
  } catch {
    signal?.throwIfAborted();
    throw unreadable();
  }
  const text = result.text.slice(0, maxTextLength).trim();
  if (text.length < 45 || !/\p{L}/u.test(text)) throw unreadable();
  return {title: result.title || new URL(url).hostname, url, text};
}

export async function readWebSource(input, signal) {
  return extractWebContent(await fetchWebResource(input, signal), signal);
}
