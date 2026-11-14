import {createHash, timingSafeEqual} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';
import {Fault, read, UUID} from './common.mjs';
import {creation} from './contracts.mjs';
import {executor as makeExecutor} from './executor.mjs';
import {cancelRevision, createProject, editProject, editScene, getProject, listProjects, metadata, resumeProjects, retryRevision, revision, revisionTrace, artifact} from './projects.mjs';
import {integerEnv} from './limits.mjs';
import {accessSnapshot, limitPayload, limitedOperation, projectAccess, requireOwner, resolveIdentity} from './guest-access.mjs';
import {publicSound} from './sound.mjs';
import {applyRixin, rixinSnapshot, saveRixin, saveRixinSettings, listStyles, saveStyle, removeStyle} from './rixin.mjs';
import {modelProviders} from './production-credit.mjs';
import {sceneIdPattern} from './scene-limits.mjs';

const jsonLimit = 256 * 1024;
const pdfLimit = 20 * 1024 * 1024;
const spec = new URL('../openapi.json', import.meta.url);
const base = '/v1/projects';
const projectRoute = new RegExp('^' + base + '/(' + UUID + ')$');
const editRoute = new RegExp('^' + base + '/(' + UUID + ')/scenes/(' + sceneIdPattern + ')$');
const rixinRoute = new RegExp('^/v1/rixin/(' + UUID + ')/(' + UUID + ')$');
const styleRoute = new RegExp('^/v1/rixin/styles(?:/(' + UUID + '))?$');
const revisionRoute = new RegExp('^' + base + '/(' + UUID + ')/revisions/(' + UUID +
  ')(?:(/(?:cancel|retry|trace))|/(?:scenes/(' + sceneIdPattern + ')/)?artifacts/([a-z0-9.\\-]{1,50}))?$');
const types = {
  '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf',
  '.png': 'image/png', '.mp4': 'video/mp4', '.wav': 'audio/wav',
  '.mjs': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.zip': 'application/zip',
};

function send(response, status, value, headers) {
  const body = JSON.stringify(value);
  response.writeHead(status, {'Content-Type': types['.json'], 'Content-Length': Buffer.byteLength(body), ...headers});
  response.end(body);
}

function location(result) {
  return base + '/' + result.projectId + '/revisions/' + result.revisionId;
}

function accepted(response, result) {
  const url = location(result);
  send(response, result.accepted ? 202 : 503, {...result, href: url}, {Location: url});
}

function sameSecret(got, expected) {
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(got), digest('Bearer ' + expected));
}

function methodAllowed(method, ...accepted) {
  if (!accepted.includes(method)) {
    const error = new Fault('METHOD_NOT_ALLOWED', 'Method not allowed', {status: 405});
    error.headers = {Allow: accepted.join(', ')};
    throw error;
  }
}

function tooLarge() {
  return new Fault('BODY_TOO_LARGE', 'Request body exceeds the upload limit', {status: 413});
}

async function bytes(request, limit) {
  const length = Number(request.headers['content-length']);
  if (length > limit) {
    request.resume();
    throw tooLarge();
  }
  const chunks = [];
  let count = 0;
  for await (const chunk of request.iterator({destroyOnReturn: false})) {
    count += chunk.length;
    if (count > limit) {
      request.resume();
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const contentType = request => request.headers['content-type']?.split(';')[0].trim().toLowerCase();

async function body(request) {
  if (contentType(request) !== 'application/json') {
    request.resume();
    throw new Fault('UNSUPPORTED_MEDIA_TYPE', 'Send application/json', {status: 415});
  }
  const payload = await bytes(request, jsonLimit);
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    throw new Fault('INVALID_JSON', 'Invalid JSON body', {status: 400});
  }
}

function range(value, size) {
  if (!value) return {start: 0, end: size - 1, partial: false};
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && start <= end && end >= 0) {
      return {start, end, partial: true};
    }
  }
  const error = new Fault('RANGE_NOT_SATISFIABLE', 'Requested byte range is invalid', {status: 416});
  error.headers = {'Content-Range': 'bytes */' + size};
  throw error;
}

async function stream(request, response, file) {
  const {size} = await stat(file);
  const {start, end, partial} = range(request.headers.range, size);
  const extension = extname(file);
  const headers = {
    'Content-Type': types[extension] || 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-cache',
  };
  if (extension === '.zip' || extension === '.pdf') headers['Content-Disposition'] = 'attachment';
  if (partial) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
  response.writeHead(partial ? 206 : 200, headers);
  if (request.method === 'HEAD') response.end();
  else await pipeline(createReadStream(file, {start, end}), response);
}

export async function createApp({executor: injectedExecutor, authenticate} = {}) {
  const executor = injectedExecutor || await makeExecutor();
  const token = process.env.API_TOKEN;
  const origins = new Set((process.env.API_ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean));
  const server = createServer(async (req, res) => {
    const {method} = req;
    const clientOrigin = req.headers.origin;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (origins.has(clientOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', clientOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'Location, Content-Range, Accept-Ranges');
      res.setHeader('Vary', 'Origin');
      if (method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
    }
    try {
      if (!req.url?.startsWith('/')) throw new Fault('INVALID_PATH', 'Invalid request target', {status: 400});
      const {pathname, searchParams} = new URL(req.url, 'http://knovid.local');
      if (pathname === '/healthz') {
        methodAllowed(method, 'GET');
        return send(res, 200, {status: 'ok'});
      }
      if (token && !sameSecret(req.headers.authorization || '', token)) {
        const error = new Fault('UNAUTHORIZED', 'Missing or invalid API bearer token', {status: 401});
        error.headers = {'WWW-Authenticate': 'Bearer'};
        throw error;
      }
      if (pathname === '/openapi.json') {
        methodAllowed(method, 'GET');
        return send(res, 200, await read(spec));
      }
      if (pathname === '/v1/audio/catalog') {
        methodAllowed(method, 'GET');
        return send(res, 200, publicSound());
      }
      const identity = await resolveIdentity(req, res, authenticate);
      res.setHeader('Cache-Control', 'private, no-store');
      if (pathname === '/v1/access') {
        methodAllowed(method, 'GET');
        return send(res, 200, {...await accessSnapshot(identity), modelProviders: modelProviders(identity)});
      }
      if (pathname === '/v1/rixin') {
        methodAllowed(method, 'GET', 'PATCH');
        return send(res, 200, method === 'GET' ? await rixinSnapshot(identity.owner) : await saveRixinSettings(identity.owner, await body(req)));
      }
      const style = styleRoute.exec(pathname);
      if (style) {
        if (identity.mode !== 'member') throw new Fault('UNAUTHENTICATED', 'Sign in to manage styles', {status: 401});
        if (!style[1]) {
          methodAllowed(method, 'GET', 'POST');
          if (method === 'GET') return send(res, 200, await listStyles(identity.owner));
          return send(res, 201, await saveStyle(identity.owner, null, await body(req)));
        }
        methodAllowed(method, 'PATCH', 'DELETE');
        return send(res, 200, method === 'PATCH'
          ? await saveStyle(identity.owner, style[1], await body(req))
          : await removeStyle(identity.owner, style[1]));
      }
      const feedback = rixinRoute.exec(pathname);
      if (feedback) {
        methodAllowed(method, 'PATCH');
        return send(res, 200, await saveRixin(identity.owner, feedback[1], feedback[2], await body(req)));
      }
      if (pathname === base) {
        methodAllowed(method, 'GET', 'POST');
        if (method === 'GET') return send(res, 200, {projects: (await listProjects()).filter(project => project.owner === identity.owner).map(({owner, ...project}) => project)});
        let pdf;
        let payload;
        if (contentType(req) === 'application/pdf') {
          pdf = await bytes(req, pdfLimit);
          const options = Object.fromEntries(['language', 'size', 'musicTrack', 'voiceStyle', 'modelProvider', 'stylePresetId']
            .filter(key => searchParams.has(key)).map(key => [key, searchParams.get(key)]));
          if (searchParams.has('sceneCount')) options.sceneCount = Number(searchParams.get('sceneCount'));
          if (searchParams.has('music')) {
            const music = searchParams.get('music');
            if (!['true', 'false'].includes(music)) throw new Fault('INVALID_INPUT', 'music must be true or false', {status: 400});
            options.music = music === 'true';
          }
          if (searchParams.has('effects')) {
            const effects = searchParams.get('effects');
            if (!['true', 'false'].includes(effects)) throw new Fault('INVALID_INPUT', 'effects must be true or false', {status: 400});
            options.effects = effects === 'true';
          }
          if (searchParams.has('narration')) {
            const narration = searchParams.get('narration');
            if (!['true', 'false'].includes(narration)) throw new Fault('INVALID_INPUT', 'narration must be a boolean', {status: 400});
            options.narration = narration === 'true';
          }
          payload = creation({input: {title: searchParams.get('title') || 'PDF'}, options}, pdf);
        } else {
          payload = creation(await body(req));
        }
        if (identity.mode === 'guest' && payload.options.modelProvider) {
          throw new Fault('PREMIUM_LOGIN_REQUIRED', 'Sign in to use paid model providers', {status: 403});
        }
        const styled = limitPayload(identity, await applyRixin(identity.owner, payload));
        return accepted(res, await limitedOperation(identity, 'create', undefined, () => createProject(executor, styled, pdf, identity.owner)));
      }
      const project = projectRoute.exec(pathname);
      if (project) {
        await requireOwner(identity, await metadata(project[1]));
        methodAllowed(method, 'GET', 'PATCH');
        if (method === 'PATCH') {
          const patch = await body(req);
          return accepted(res, await limitedOperation(identity, 'edit', project[1], () => editProject(executor, project[1], patch)));
        }
        const result = await getProject(project[1]);
        return send(res, 200, {...result, access: await projectAccess(identity, result.id, result.latest.status, result.options, result.latest.sourceRevisionId)});
      }
      const edit = editRoute.exec(pathname);
      if (edit) {
        await requireOwner(identity, await metadata(edit[1]));
        methodAllowed(method, 'PATCH');
        const patch = await body(req);
        return accepted(res, await limitedOperation(identity, 'edit', edit[1], () => editScene(executor, edit[1], edit[2], patch)));
      }
      const match = revisionRoute.exec(pathname);
      if (match) {
        const [, id, version, action, scene, file] = match;
        await requireOwner(identity, await metadata(id));
        if (file) {
          methodAllowed(method, 'GET', 'HEAD');
          return await stream(req, res, await artifact(id, version, file, scene));
        }
        if (action === '/cancel') {
          methodAllowed(method, 'POST');
          return send(res, 202, await cancelRevision(executor, id, version));
        }
        if (action === '/retry') {
          methodAllowed(method, 'POST');
          return accepted(res, await limitedOperation(identity, 'retry', id, () => retryRevision(executor, id, version)));
        }
        methodAllowed(method, 'GET');
        if (action === '/trace') return send(res, 200, await revisionTrace(executor, id, version));
        return send(res, 200, await revision(id, version));
      }
      throw new Fault('NOT_FOUND', 'Route does not exist', {status: 404});
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof Fault) {
        return send(res, error.status, {error: {code: error.code, message: error.message}}, error.headers);
      }
      console.error('API request failed', error.name, error.code || '');
      return send(res, 500, {error: {code: 'SERVER_ERROR', message: 'Unexpected server error'}});
    }
  });
  server.requestTimeout = 120_000;
  await resumeProjects(executor);
  return {server, executor};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {server, executor} = await createApp();
  const host = process.env.HOST || '127.0.0.1';
  const port = integerEnv('PORT', 8080, 1, 65535);
  server.listen(port, host, () => console.info('KnoVid REST API listening on ' + host + ':' + port));
  const shutdown = async () => {
    server.close();
    await executor.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
