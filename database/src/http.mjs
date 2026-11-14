import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError, creditAmount, uuid } from './errors.mjs';

const COOKIE_NAME = 'knovid_session';
const BODY_LIMIT = 16 * 1024;
const ROUTES = new Map([
  ['/api/auth/register', 'POST'],
  ['/api/auth/login', 'POST'],
  ['/api/auth/logout', 'POST'],
  ['/api/auth/me', 'GET'],
  ['/api/account', 'PATCH'],
  ['/api/account/password', 'POST'],
  ['/api/credits', 'GET'],
  ['/api/credits/ledger', 'GET'],
]);

/** Return an opaque session token, never a user ID or an unverified identity. */
export function getSessionToken(req) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  const cookies = header.split(';').map((part) => part.trim());
  const matches = cookies.filter((part) => part.startsWith(`${COOKIE_NAME}=`));
  // Reject ambiguous cookies (for example two cookies set with different paths).
  if (matches.length !== 1) return undefined;
  const token = matches[0].slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

function json(res, status, payload) {
  res.statusCode = status;
  if (status === 204) return res.end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function sessionCookie(token, expiresAt, secure) {
  const attributes = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function clearCookie(secure) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Read a small JSON object, retaining the connection long enough to send a 413. */
async function readJson(req) {
  const type = req.headers['content-type'];
  if (typeof type !== 'string' || type.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    req.resume();
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '请求正文须为 JSON。', 415);
  }
  const declaredLength = req.headers['content-length'];
  if (declaredLength !== undefined && Number(declaredLength) > BODY_LIMIT) {
    req.resume();
    throw new AppError('BODY_TOO_LARGE', '请求正文过大。', 413);
  }
  const data = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    function cleanup() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    }
    function fail(error) {
      cleanup();
      req.resume();
      reject(error);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(new AppError('BODY_TOO_LARGE', '请求正文过大。', 413));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }
    function onError() { fail(new AppError('INVALID_REQUEST', '无法读取请求。', 400)); }
    function onAborted() { fail(new AppError('INVALID_REQUEST', '请求已中断。', 400)); }
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
  try {
    const value = JSON.parse(data);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw new AppError('INVALID_JSON', '请求正文须为 JSON 对象。', 400);
  }
}

function requireFields(body, fields) {
  if (Object.keys(body).some((key) => !fields.includes(key))) {
    throw new AppError('INVALID_INPUT', '请求包含不支持的字段。', 400);
  }
  if (fields.some((key) => typeof body[key] !== 'string')) {
    throw new AppError('INVALID_INPUT', '请填写必需的文本字段。', 400);
  }
  return body;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Private service endpoint for the video API and workflow workers. */
export function createProductionCreditHandler({ credits, access, token }) {
  const expected = token && createHash('sha256').update('Bearer ' + token).digest();
  const actions = new Set(['reserve', 'capture', 'release']);
  const providers = new Set(['deepseek', 'openrouter']);

  return async function handleProductionCredit(req, res) {
    if (!expected || req.url !== '/internal/production-credit') return false;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const supplied = createHash('sha256').update(req.headers.authorization || '').digest();
      if (!timingSafeEqual(supplied, expected)) throw new AppError('UNAUTHENTICATED', 'Authentication required.', 401);
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new AppError('METHOD_NOT_ALLOWED', 'Use POST.', 405);
      }
      const payload = await readJson(req);
      const {action, userId, projectId, revisionId, amount, provider, capturedAmount} = payload;
      if (action === 'quote' && Object.keys(payload).length === 2) {
        json(res, 200, await credits.getBalance(uuid(userId)));
        return true;
      }
      const fields = ['action', 'userId', 'projectId', 'revisionId', 'amount', 'provider'];
      if (action === 'capture') fields.push('capturedAmount');
      if (Object.keys(payload).length !== fields.length || !fields.every(field => Object.hasOwn(payload, field))
        || !actions.has(action) || !providers.has(provider)) {
        throw new AppError('INVALID_INPUT', 'Invalid production credit operation.');
      }
      const input = {
        userId: uuid(userId),
        projectId: uuid(projectId).toLowerCase(),
        revisionId: uuid(revisionId).toLowerCase(),
        amount: creditAmount(amount),
      };
      input.operationKey = `production:${provider}:${input.projectId}:${input.revisionId}`;
      const settlement = {userId: input.userId, operationKey: input.operationKey, expectedAmount: input.amount};
      let result;
      if (action === 'reserve') {
        await access.bind(input);
        result = await credits.reserve(input);
      } else if (action === 'capture') {
        result = await credits.capture({...settlement, amount: creditAmount(capturedAmount)});
      } else {
        await access.bind({...input, requireActive: false});
        result = await credits.release({...settlement, unstarted: {projectId: input.projectId, revisionId: input.revisionId}});
      }
      json(res, 200, {...result, provider});
    } catch (error) {
      req.resume();
      if (error instanceof AppError) json(res, error.status, {code: error.code, message: error.message});
      else {
        console.error('Production credit request failed', error?.name, error?.code || '');
        json(res, 503, {code: 'SERVICE_UNAVAILABLE', message: 'Credit service temporarily unavailable.'});
      }
    }
    return true;
  };
}

function parseLedgerQuery(url) {
  for (const name of url.searchParams.keys()) {
    if (!['limit', 'before'].includes(name) || url.searchParams.getAll(name).length !== 1) {
      throw new AppError('INVALID_INPUT', '流水查询参数不正确。', 400);
    }
  }
  const raw = url.searchParams.get('limit');
  if (raw !== null && (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > 100)) {
    throw new AppError('INVALID_INPUT', 'limit 必须是 1 到 100 的整数。', 400);
  }
  const before = url.searchParams.get('before');
  if (before !== null && (before.length === 0 || before.length > 512)) {
    throw new AppError('INVALID_INPUT', '流水游标不正确。', 400);
  }
  return { limit: raw === null ? 20 : Number(raw), ...(before === null ? {} : { before }) };
}

/**
 * Mount before the host server's 404 handler. Returns false for unrelated paths.
 * The host must also authenticate its project/media routes and enforce ownership.
 * Mutation callers (including CLI scripts) must send an explicitly allowed Origin.
 */
export function createAccountHandler({ accounts, credits, allowedOrigins = [], secureCookies = true }) {
  if (!accounts || !credits) throw new TypeError('accounts and credits are required');
  if (!Array.isArray(allowedOrigins)) throw new TypeError('allowedOrigins must be an array');
  const origins = new Set(allowedOrigins.map((origin) => {
    let url;
    try { url = new URL(origin); } catch { throw new TypeError('Invalid allowed origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new TypeError('Allowed origins must be exact HTTP(S) origins, without paths or trailing slashes');
    }
    return origin;
  }));

  return async function handleAccountRequest(req, res) {
    let url;
    try { url = new URL(req.url, 'http://knovid.internal'); } catch { return false; }
    const method = ROUTES.get(url.pathname);
    if (!method) return false;

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The handler owns these routes and their CORS policy, not an upstream wildcard.
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Access-Control-Allow-Credentials');
    const oldVary = res.getHeader('Vary');
    res.setHeader('Vary', oldVary ? `${oldVary}, Origin` : 'Origin');
    const origin = req.headers.origin;
    const trustedOrigin = typeof origin === 'string' && origins.has(origin);
    if (trustedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    try {
      if (req.method === 'OPTIONS') {
        if (!trustedOrigin) throw new AppError('ORIGIN_NOT_ALLOWED', '请求来源不被允许。', 403);
        const requested = req.headers['access-control-request-method'];
        const requestedHeaders = String(req.headers['access-control-request-headers'] || '')
          .split(',').map((header) => header.trim().toLowerCase()).filter(Boolean);
        if (requested !== method || requestedHeaders.some((header) => !['content-type', 'accept'].includes(header))) {
          throw new AppError('CORS_NOT_ALLOWED', '跨域请求不被允许。', 403);
        }
        res.setHeader('Access-Control-Allow-Methods', method);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
        res.setHeader('Access-Control-Max-Age', '600');
        json(res, 204);
        return true;
      }
      if (req.method !== method) {
        res.setHeader('Allow', `${method}, OPTIONS`);
        throw new AppError('METHOD_NOT_ALLOWED', '不支持此请求方式。', 405);
      }
      if (method !== 'GET' && !trustedOrigin) {
        throw new AppError('ORIGIN_NOT_ALLOWED', '请求来源不被允许。', 403);
      }

      if (url.pathname === '/api/auth/register' || url.pathname === '/api/auth/login') {
        // Trust the peer socket only. X-Forwarded-For is attacker-controlled unless
        // a separately configured trusted proxy strips and verifies it.
        const peer = req.socket.remoteAddress || 'unknown';
        await accounts.consumeRateLimit(`http:auth:ip:${digest(peer)}`, { limit: 60, windowSeconds: 900 });
        const registration = url.pathname.endsWith('/register');
        const body = requireFields(await readJson(req), registration
          ? ['email', 'password', 'displayName'] : ['email', 'password']);
        const email = body.email.trim().toLowerCase();
        await accounts.consumeRateLimit(`http:${registration ? 'register' : 'login'}:email:${digest(email)}`, {
          limit: registration ? 5 : 10,
          windowSeconds: 900,
        });
        const result = registration ? await accounts.register(body) : await accounts.login(body);
        res.setHeader('Set-Cookie', sessionCookie(result.token, result.expiresAt, secureCookies));
        json(res, registration ? 201 : 200, { user: result.user });
        return true;
      }

      const token = getSessionToken(req);
      if (url.pathname === '/api/auth/logout') {
        // Logging out an already-expired session is a successful, idempotent action.
        if (token) await accounts.logout(token);
        res.setHeader('Set-Cookie', clearCookie(secureCookies));
        json(res, 204);
        return true;
      }
      const user = await accounts.authenticate(token);
      switch (url.pathname) {
        case '/api/auth/me':
          json(res, 200, { user });
          break;
        case '/api/account': {
          const body = requireFields(await readJson(req), ['displayName']);
          json(res, 200, { user: await accounts.updateProfile(user.id, body) });
          break;
        }
        case '/api/account/password': {
          await accounts.consumeRateLimit(`http:password:user:${user.id}`, { limit: 10, windowSeconds: 900 });
          const body = requireFields(await readJson(req), ['currentPassword', 'newPassword']);
          await accounts.changePassword(user.id, body);
          res.setHeader('Set-Cookie', clearCookie(secureCookies));
          json(res, 204);
          break;
        }
        case '/api/credits':
          if (url.search) throw new AppError('INVALID_INPUT', '余额查询不接受账号参数。', 400);
          json(res, 200, await credits.getBalance(user.id));
          break;
        case '/api/credits/ledger':
          json(res, 200, await credits.listLedger(user.id, parseLedgerQuery(url)));
          break;
      }
    } catch (error) {
      if (res.headersSent) return true;
      if (error instanceof AppError) {
        if (error.status === 429) {
          const retryAfter = Number.isInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0
            ? error.retryAfterSeconds : 900;
          res.setHeader('Retry-After', String(retryAfter));
        }
        json(res, error.status, { code: error.code, message: error.message });
      } else {
        json(res, 500, { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。' });
      }
    }
    return true;
  };
}
