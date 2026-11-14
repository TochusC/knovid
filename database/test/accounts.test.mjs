import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { AccountService } from '../src/accounts.mjs';
import { createTestDatabase } from './support.mjs';

let db;
let close;
let accounts;
let sequence = 0;
const PASSWORD = 'correct-horse-battery';
const input = (overrides = {}) => ({ email: `account-${++sequence}@example.com`, password: PASSWORD, displayName: '知识创作者', ...overrides });
const hasCode = (code) => (error) => error.code === code;

before(async () => {
  ({ db, close } = await createTestDatabase());
  accounts = new AccountService(db);
});
after(async () => { await close?.(); });

test('registration normalizes email, creates a zero-credit wallet and stores only secret hashes', async () => {
  const registered = await accounts.register(input({ email: '  Author@Example.com  ' }));
  assert.equal(registered.user.email, 'author@example.com');
  assert.equal(registered.user.displayName, '知识创作者');
  assert.match(registered.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(new Date(registered.expiresAt) > new Date());
  assert.equal('password_hash' in registered.user, false);
  assert.equal('passwordHash' in registered.user, false);
  const { rows: userRows } = await db.query('SELECT password_hash FROM knovid_users WHERE id = $1', [registered.user.id]);
  assert.match(userRows[0].password_hash, /^scrypt\$131072\$8\$1\$/);
  assert.equal(userRows[0].password_hash.includes(PASSWORD), false);
  const { rows: sessions } = await db.query('SELECT token_hash FROM knovid_sessions WHERE user_id = $1', [registered.user.id]);
  assert.equal(sessions[0].token_hash, createHash('sha256').update(registered.token).digest('hex'));
  assert.notEqual(sessions[0].token_hash, registered.token);
  const { rows: wallets } = await db.query('SELECT balance, reserved FROM knovid_credit_accounts WHERE user_id = $1', [registered.user.id]);
  assert.deepEqual(wallets, [{ balance: 0, reserved: 0 }]);
  assert.equal((await accounts.authenticate(registered.token)).id, registered.user.id);
  await assert.rejects(accounts.register(input({ email: 'AUTHOR@EXAMPLE.COM' })), hasCode('EMAIL_EXISTS'));
});

test('configured signup grant is issued in the same registration transaction', async () => {
  const withGrant = new AccountService(db, { signupCredits: 75 });
  const registered = await withGrant.register(input());
  const { rows } = await db.query('SELECT balance, reserved FROM knovid_credit_accounts WHERE user_id = $1', [registered.user.id]);
  assert.deepEqual(rows[0], { balance: 75, reserved: 0 });
});

test('a late registration failure rolls back user, wallet, grant and session', async () => {
  const failureInput = input();
  const failingDb = {
    transaction: (fn) => db.transaction((tx) => fn({
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO knovid_sessions')) throw new Error('injected session failure');
        return tx.query(sql, params);
      },
    })),
  };
  const failing = new AccountService(failingDb, { signupCredits: 30 });
  await assert.rejects(failing.register(failureInput), /injected session failure/);
  const { rows } = await db.query('SELECT id FROM knovid_users WHERE email = $1', [failureInput.email]);
  assert.deepEqual(rows, []);
});

test('login errors do not disclose whether an account exists; logout is idempotent', async () => {
  const credentials = input();
  const registered = await accounts.register(credentials);
  const loggedIn = await accounts.login({ email: credentials.email.toUpperCase(), password: PASSWORD });
  assert.equal(loggedIn.user.id, registered.user.id);
  assert.notEqual(loggedIn.token, registered.token);
  const badExisting = await accounts.login({ email: credentials.email, password: 'wrong' }).catch((e) => e);
  const badMissing = await accounts.login({ email: 'missing@example.com', password: 'wrong' }).catch((e) => e);
  assert.equal(badExisting.code, 'INVALID_CREDENTIALS');
  assert.equal(badExisting.message, badMissing.message);
  assert.equal(badExisting.status, 401);
  await accounts.logout(loggedIn.token);
  await accounts.logout(loggedIn.token);
  await assert.rejects(accounts.authenticate(loggedIn.token), hasCode('UNAUTHENTICATED'));
  assert.equal((await accounts.authenticate(registered.token)).id, registered.user.id);
});

test('expired, malformed and unknown session tokens cannot authenticate', async () => {
  const registered = await accounts.register(input());
  await db.query("UPDATE knovid_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [registered.user.id]);
  for (const token of [registered.token, undefined, '', 'a'.repeat(43), '../../secret']) {
    await assert.rejects(accounts.authenticate(token), hasCode('UNAUTHENTICATED'));
  }
});

test('login bounds active sessions and removes the oldest tokens', async () => {
  const credentials = input();
  const registered = await accounts.register(credentials);
  let oldestToken;
  for (let index = 1; index <= 12; index++) {
    const token = Buffer.alloc(32, index).toString('base64url');
    oldestToken = token;
    await db.query(`INSERT INTO knovid_sessions (token_hash, user_id, created_at, expires_at)
      VALUES ($1, $2, now() - $3 * interval '1 minute', now() + interval '1 day')`,
    [createHash('sha256').update(token).digest('hex'), registered.user.id, index]);
  }
  const current = await accounts.login(credentials);
  const { rows } = await db.query('SELECT count(*)::integer AS count FROM knovid_sessions WHERE user_id = $1', [registered.user.id]);
  assert.equal(rows[0].count, 10);
  await assert.rejects(accounts.authenticate(oldestToken), hasCode('UNAUTHENTICATED'));
  assert.equal((await accounts.authenticate(current.token)).id, registered.user.id);
});

test('password changes check the old password and revoke every existing session', async () => {
  const credentials = input();
  const first = await accounts.register(credentials);
  const second = await accounts.login(credentials);
  await assert.rejects(accounts.changePassword(first.user.id, { currentPassword: 'wrong', newPassword: 'new-password-for-testing' }), hasCode('INVALID_CREDENTIALS'));
  assert.equal((await accounts.authenticate(first.token)).id, first.user.id);
  await accounts.changePassword(first.user.id, { currentPassword: PASSWORD, newPassword: 'new-password-for-testing' });
  await assert.rejects(accounts.authenticate(first.token), hasCode('UNAUTHENTICATED'));
  await assert.rejects(accounts.authenticate(second.token), hasCode('UNAUTHENTICATED'));
  await assert.rejects(accounts.login(credentials), hasCode('INVALID_CREDENTIALS'));
  assert.equal((await accounts.login({ email: credentials.email, password: 'new-password-for-testing' })).user.id, first.user.id);
});

test('concurrent login and password change never leave an old-password session valid', async () => {
  const credentials = input();
  const first = await accounts.register(credentials);
  const [loginResult] = await Promise.allSettled([
    accounts.login(credentials),
    accounts.changePassword(first.user.id, { currentPassword: PASSWORD, newPassword: 'changed-in-concurrent-test' }),
  ]);
  if (loginResult.status === 'fulfilled') await assert.rejects(accounts.authenticate(loginResult.value.token), hasCode('UNAUTHENTICATED'));
  else assert.equal(loginResult.reason.code, 'INVALID_CREDENTIALS');
  assert.equal((await accounts.login({ email: credentials.email, password: 'changed-in-concurrent-test' })).user.id, first.user.id);
});

test('disabling an account blocks login and revokes sessions even after reactivation', async () => {
  const credentials = input();
  const first = await accounts.register(credentials);
  assert.equal((await accounts.setStatus(first.user.id, 'disabled')).status, 'disabled');
  await assert.rejects(accounts.authenticate(first.token), hasCode('UNAUTHENTICATED'));
  await assert.rejects(accounts.login(credentials), hasCode('INVALID_CREDENTIALS'));
  await assert.rejects(accounts.updateProfile(first.user.id, { displayName: 'Disabled' }), hasCode('ACCOUNT_UNAVAILABLE'));
  await accounts.setStatus(first.user.id, 'active');
  await assert.rejects(accounts.authenticate(first.token), hasCode('UNAUTHENTICATED'));
  assert.equal((await accounts.login(credentials)).user.status, 'active');
});

test('profile updates validate names and public listing does not return credentials', async () => {
  const first = await accounts.register(input());
  assert.equal((await accounts.updateProfile(first.user.id, { displayName: '  新名字  ' })).displayName, '新名字');
  await assert.rejects(accounts.updateProfile(first.user.id, { displayName: ' ' }), hasCode('INVALID_INPUT'));
  const firstPage = await accounts.listUsers({ limit: 2 });
  assert.equal(firstPage.users.length, 2);
  assert.ok(firstPage.nextCursor);
  const secondPage = await accounts.listUsers({ limit: 2, before: firstPage.nextCursor });
  assert.equal(secondPage.users.some((u) => firstPage.users.some((firstUser) => firstUser.id === u.id)), false);
  assert.equal(JSON.stringify(firstPage).includes('password'), false);
  assert.equal(JSON.stringify(firstPage).includes('token'), false);
});

test('fixed-window throttling persists and atomically limits competing callers', async () => {
  const otherProcess = new AccountService(db);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? accounts : otherProcess).consumeRateLimit('login:shared-test', { limit: 3, windowSeconds: 60 })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  for (const denied of results.filter((r) => r.status === 'rejected')) {
    assert.equal(denied.reason.code, 'RATE_LIMITED');
    assert.equal(denied.reason.status, 429);
    assert.ok(denied.reason.retryAfterSeconds > 0);
  }
  await assert.rejects(otherProcess.consumeRateLimit('login:shared-test', { limit: 3, windowSeconds: 60 }), hasCode('RATE_LIMITED'));
  await db.query("UPDATE knovid_auth_limits SET window_start = now() - interval '61 seconds' WHERE key = $1", ['login:shared-test']);
  assert.equal((await accounts.consumeRateLimit('login:shared-test', { limit: 3, windowSeconds: 60 })).remaining, 2);
});

test('invalid account and configuration inputs fail before persisting changes', async () => {
  assert.throws(() => new AccountService(db, { signupCredits: -1 }), hasCode('INVALID_INPUT'));
  assert.throws(() => new AccountService(db, { sessionTtlSeconds: 0 }), hasCode('INVALID_INPUT'));
  for (const overrides of [{ email: 'invalid' }, { password: 'short' }, { password: 'a'.repeat(129) }, { displayName: 'x'.repeat(81) }]) {
    await assert.rejects(accounts.register(input(overrides)), hasCode('INVALID_INPUT'));
  }
  await assert.rejects(accounts.setStatus('not-uuid', 'disabled'), hasCode('INVALID_INPUT'));
  await assert.rejects(accounts.listUsers({ limit: 101 }), hasCode('INVALID_INPUT'));
});
