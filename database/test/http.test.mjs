import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { AccountService } from '../src/accounts.mjs';
import { ProjectAccessService } from '../src/access.mjs';
import { CreditService } from '../src/credits.mjs';
import { createAccountHandler, createProductionCreditHandler, getSessionToken } from '../src/http.mjs';
import { createTestDatabase } from './support.mjs';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery staple';
let fixture;
let accounts;
let credits;
let server;
let base;

async function serve(handler) {
  const server = createServer(async (req, res) => {
    if (!await handler(req, res)) {
      res.statusCode = 404;
      res.end('Not found');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

before(async () => {
  fixture = await createTestDatabase();
  accounts = new AccountService(fixture.db);
  credits = new CreditService(fixture.db);
  const handleAccount = createAccountHandler({
    accounts, credits, allowedOrigins: [ORIGIN], secureCookies: false,
  });
  const handleProduction = createProductionCreditHandler({
    credits, access: new ProjectAccessService(fixture.db), token: 'integration-test-token',
  });
  ({ server, base } = await serve(async (req, res) => await handleProduction(req, res) || await handleAccount(req, res)));
});

after(async () => {
  if (server) await stop(server);
  if (fixture) await fixture.close();
});

async function call(path, { method = 'GET', body, cookie, origin = ORIGIN, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(origin === null ? {} : { Origin: origin }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = response.headers.get('content-type')?.includes('application/json')
    ? await response.json() : undefined;
  return { response, payload, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] };
}

async function register(prefix = 'http') {
  const email = `${prefix}-${randomUUID()}@example.test`;
  const result = await call('/api/auth/register', {
    method: 'POST', body: { email, password: PASSWORD, displayName: '知识创作者' },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  return { ...result, email, user: result.payload.user };
}

test('register, current account, profile, balance and logout use an opaque HttpOnly session', async () => {
  const created = await register();
  assert.deepEqual(Object.keys(created.payload), ['user']);
  assert.equal(created.user.email, created.email);
  assert.equal(created.user.displayName, '知识创作者');
  assert.equal(created.user.passwordHash, undefined);
  assert.equal(created.user.password_hash, undefined);
  assert.match(created.cookie, /^knovid_session=[\w-]{43}$/);
  const header = created.response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Path=\//);
  assert.doesNotMatch(header, /; Secure/);
  assert.equal(created.response.headers.get('cache-control'), 'no-store');

  const me = await call('/api/auth/me', { cookie: created.cookie });
  assert.equal(me.response.status, 200);
  assert.equal(me.payload.user.id, created.user.id);
  const updated = await call('/api/account', {
    method: 'PATCH', cookie: created.cookie, body: { displayName: '新昵称' },
  });
  assert.equal(updated.payload.user.displayName, '新昵称');
  const balance = await call('/api/credits', { cookie: created.cookie });
  assert.deepEqual(balance.payload, { balance: 0, reserved: 0, available: 0 });

  const loggedOut = await call('/api/auth/logout', { method: 'POST', cookie: created.cookie });
  assert.equal(loggedOut.response.status, 204);
  assert.match(loggedOut.response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call('/api/auth/me', { cookie: created.cookie })).response.status, 401);
  assert.equal((await call('/api/auth/logout', { method: 'POST', cookie: created.cookie })).response.status, 204);
});

test('login creates a new session and password change invalidates every old session', async () => {
  const created = await register('password');
  const login = await call('/api/auth/login', {
    method: 'POST', body: { email: created.email.toUpperCase(), password: PASSWORD },
  });
  assert.equal(login.response.status, 200);
  assert.notEqual(login.cookie, created.cookie);
  const changed = await call('/api/account/password', {
    method: 'POST', cookie: created.cookie,
    body: { currentPassword: PASSWORD, newPassword: 'a different secure passphrase' },
  });
  assert.equal(changed.response.status, 204);
  assert.match(changed.response.headers.get('set-cookie'), /Max-Age=0/);
  for (const cookie of [created.cookie, login.cookie]) {
    assert.equal((await call('/api/auth/me', { cookie })).response.status, 401);
  }
  assert.equal((await call('/api/auth/login', {
    method: 'POST', body: { email: created.email, password: PASSWORD },
  })).response.status, 401);
  assert.equal((await call('/api/auth/login', {
    method: 'POST', body: { email: created.email, password: 'a different secure passphrase' },
  })).response.status, 200);
});

test('credit reads and ledger are scoped to the session; client cannot choose or mint balances', async () => {
  const alice = await register('alice');
  const bob = await register('bob');
  await credits.grant({ userId: alice.user.id, amount: 120, idempotencyKey: randomUUID(), reason: 'test grant' });
  const balance = await call('/api/credits', { cookie: alice.cookie });
  assert.deepEqual(balance.payload, { balance: 120, reserved: 0, available: 120 });
  const ledger = await call('/api/credits/ledger?limit=1', { cookie: alice.cookie });
  assert.equal(ledger.response.status, 200);
  assert.equal(ledger.payload.entries.length, 1);
  const bobLedger = await call('/api/credits/ledger', { cookie: bob.cookie });
  assert.deepEqual(bobLedger.payload, { entries: [], nextCursor: null });
  assert.equal((await call(`/api/credits?userId=${alice.user.id}`, { cookie: bob.cookie })).response.status, 400);
  assert.equal((await call(`/api/credits/ledger?userId=${alice.user.id}`, { cookie: bob.cookie })).response.status, 400);
  assert.equal((await call('/api/credits', {
    method: 'POST', cookie: bob.cookie, body: { amount: 500 },
  })).response.status, 405);
  assert.equal((await call('/api/credits/grant', {
    method: 'POST', cookie: bob.cookie, body: { amount: 500 },
  })).response.status, 404);
  assert.equal((await call('/api/account', {
    method: 'PATCH', cookie: bob.cookie, body: { displayName: 'X', userId: alice.user.id },
  })).response.status, 400);
  for (const query of ['limit=0', 'limit=1.5', 'limit=101', 'limit=2&limit=3', 'before=']) {
    assert.equal((await call(`/api/credits/ledger?${query}`, { cookie: bob.cookie })).response.status, 400);
  }
});

test('private production billing authenticates, atomically reserves, and settles once per revision', async () => {
  const account = await register('production');
  const userId = account.user.id;
  const operation = {
    userId, projectId: randomUUID(), revisionId: randomUUID(), amount: 12, provider: 'deepseek',
  };
  const billingPath = '/internal/production-credit';
  const settle = (body) => call(billingPath, {
    method: 'POST', body, origin: null, headers: { Authorization: 'Bearer integration-test-token' },
  });
  const reserve = {action: 'reserve', ...operation};
  assert.equal((await call(billingPath, {
    method: 'POST', cookie: account.cookie, body: reserve,
  })).response.status, 401);
  assert.equal((await settle(reserve)).response.status, 402);
  await credits.grant({userId, amount: 20, idempotencyKey: randomUUID(), reason: 'test grant'});

  const competing = {...reserve, revisionId: randomUUID(), provider: 'openrouter'};
  const attempts = await Promise.all([settle(reserve), settle(competing)]);
  assert.deepEqual(attempts.map(({response}) => response.status).sort(), [200, 402]);
  const [winner] = [reserve, competing].filter((_attempt, index) => attempts[index].response.ok);
  const {payload: held} = await settle(winner);
  assert.equal(held.projectId, operation.projectId);
  assert.equal(held.revisionId, winner.revisionId);
  assert.equal(held.provider, winner.provider);
  assert.equal(held.state, 'reserved');
  assert.equal((await settle({...winner, action: 'capture', amount: 11, capturedAmount: 4})).response.status, 409);
  assert.equal((await settle({...winner, action: 'capture', capturedAmount: 13})).response.status, 400);
  const capture = {...winner, action: 'capture', capturedAmount: 4};
  for (let retry = 0; retry < 2; retry++) {
    const outcome = await settle(capture);
    assert.equal(outcome.response.status, 200);
    assert.equal(outcome.payload.state, 'captured');
    assert.equal(outcome.payload.capturedAmount, 4);
  }
  assert.deepEqual((await settle({action: 'quote', userId})).payload, {balance: 16, reserved: 0, available: 16});
  assert.equal((await settle({...winner, action: 'release'})).response.status, 409);

  const cancellation = {...operation, projectId: randomUUID(), revisionId: randomUUID(), provider: 'openrouter'};
  assert.equal((await settle({...cancellation, action: 'release'})).payload.state, 'released');
  assert.equal((await settle({...cancellation, action: 'reserve'})).payload.state, 'released');
  const {entries} = await credits.listLedger(userId);
  assert.deepEqual(entries.map(entry => entry.kind), ['capture', 'reserve', 'grant']);
});

test('CORS is an exact allowlist and every mutation requires a trusted Origin', async () => {
  for (const origin of [null, 'null', 'https://attacker.example', `${ORIGIN}.attacker.example`]) {
    const denied = await call('/api/auth/login', { method: 'POST', origin, body: { email: 'x', password: 'x' } });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.response.headers.get('access-control-allow-origin'), null);
  }
  const allowed = await call('/api/auth/login', {
    method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(allowed.response.status, 204);
  assert.equal(allowed.response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(allowed.response.headers.get('access-control-allow-credentials'), 'true');
  const deniedHeader = await call('/api/auth/login', {
    method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-admin-role' },
  });
  assert.equal(deniedHeader.response.status, 403);
  const invalidMethod = await call('/api/auth/login', {
    method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'DELETE' },
  });
  assert.equal(invalidMethod.response.status, 403);
  const untrustedRead = await call('/api/auth/me', { origin: 'https://attacker.example' });
  assert.equal(untrustedRead.response.headers.get('access-control-allow-origin'), null);
  assert.equal(untrustedRead.response.status, 401);
});

test('invalid JSON, extra fields, unsupported content type and oversized body are rejected', async () => {
  for (const body of [null, [], 'text', { email: 'a', password: 'b', role: 'admin' }]) {
    const result = await call('/api/auth/login', { method: 'POST', body });
    assert.equal(result.response.status, 400);
  }
  const malformed = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  const text = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' }, body: '{}',
  });
  assert.equal(text.status, 415);
  const oversize = await call('/api/auth/login', { method: 'POST', body: { email: 'a', password: 'x'.repeat(17_000) } });
  assert.equal(oversize.response.status, 413);
  const chunkedStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/auth/login`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write('{"password":"');
    req.write('x'.repeat(17_000));
    req.end('"}');
  });
  assert.equal(chunkedStatus, 413);
});

test('anonymous and ambiguous-cookie requests cannot access private account routes', async () => {
  for (const path of ['/api/auth/me', '/api/credits', '/api/credits/ledger']) {
    assert.equal((await call(path, { origin: null })).response.status, 401);
  }
  const token = 'a'.repeat(43);
  assert.equal(getSessionToken({ headers: { cookie: `other=123; knovid_session=${token}` } }), token);
  assert.equal(getSessionToken({ headers: { cookie: `knovid_session=${token}; knovid_session=${token}` } }), undefined);
  assert.equal(getSessionToken({ headers: { cookie: 'knovid_session=untrusted%20value' } }), undefined);
  const created = await register('ambiguous');
  assert.equal((await call('/api/auth/me', { cookie: `${created.cookie}; ${created.cookie}` })).response.status, 401);
  const invalidMethod = await call('/api/auth/me', { method: 'POST' });
  assert.equal(invalidMethod.response.status, 405);
  assert.equal(invalidMethod.response.headers.get('allow'), 'GET, OPTIONS');
});

test('authentication throttling is persistent and returns Retry-After without trusting forwarded IP', async () => {
  const email = `limited-${randomUUID()}@example.test`;
  const key = `http:login:email:${createHash('sha256').update(email).digest('hex')}`;
  for (let i = 0; i < 10; i++) await accounts.consumeRateLimit(key, { limit: 10, windowSeconds: 900 });
  const result = await call('/api/auth/login', {
    method: 'POST', body: { email, password: PASSWORD }, headers: { 'X-Forwarded-For': '8.8.8.8' },
  });
  assert.equal(result.response.status, 429);
  assert.equal(result.payload.code, 'RATE_LIMITED');
  assert.ok(Number(result.response.headers.get('retry-after')) > 0);
});

test('secure cookies default on and unexpected service errors do not expose internals', async () => {
  const local = await serve(createAccountHandler({ accounts, credits, allowedOrigins: [ORIGIN] }));
  try {
    const response = await fetch(`${local.base}/api/auth/register`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `secure-${randomUUID()}@example.test`, password: PASSWORD, displayName: 'Secure' }),
    });
    assert.equal(response.status, 201);
    assert.match(response.headers.get('set-cookie'), /; Secure/);
  } finally { await stop(local.server); }

  const broken = await serve(createAccountHandler({
    accounts: { authenticate: async () => { throw new Error('password_hash SQL postgres://secret'); } },
    credits, allowedOrigins: [ORIGIN],
  }));
  try {
    const response = await fetch(`${broken.base}/api/auth/me`);
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.code, 'INTERNAL_ERROR');
    assert.doesNotMatch(JSON.stringify(payload), /postgres|password_hash|secret/);
  } finally { await stop(broken.server); }
  assert.throws(() => createAccountHandler({ accounts, credits, allowedOrigins: ['*'] }), TypeError);
  assert.throws(() => createAccountHandler({ accounts, credits, allowedOrigins: ['http://localhost:5173/'] }), TypeError);
});
