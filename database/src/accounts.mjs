import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from './errors.mjs';
import { grantInTransaction } from './credits.mjs';

const scrypt = promisify(scryptCallback);
const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_COLUMNS = 'id, email, display_name, status, created_at, updated_at';
// A valid-cost dummy avoids skipping the password KDF for nonexistent accounts.
const DUMMY_HASH = `scrypt$131072$8$1$${Buffer.alloc(16, 17).toString('base64url')}$${Buffer.alloc(64, 23).toString('base64url')}`;

function invalid(message) { throw new AppError('INVALID_INPUT', message, 400); }
function positiveInteger(value, name, maximum = 2147483647) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid(`${name} must be a positive integer up to ${maximum}.`);
  return value;
}
function userId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid('Invalid user ID.');
  return value;
}
function emailAddress(value) {
  if (typeof value !== 'string') invalid('Email is required.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || /[\u0000-\u001f\u007f]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('Enter a valid email address.');
  return email;
}
function passwordValue(value, requireMinimum = true) {
  if (typeof value !== 'string' || value.length > 128 || Buffer.byteLength(value) > 512 || (requireMinimum && value.length < 12)) {
    invalid('Password must contain 12 to 128 characters.');
  }
  return value;
}
function displayNameValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) invalid('Display name must contain 1 to 80 characters.');
  return value.trim();
}
function iso(value) { return new Date(value).toISOString(); }
function publicUser(row) {
  return { id: row.id, email: row.email, displayName: row.display_name, status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function sessionHash(token) { return createHash('sha256').update(token).digest('hex'); }
function unauthenticated() { return new AppError('UNAUTHENTICATED', 'A valid session is required.', 401); }
function badCredentials() { return new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401); }

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$131072$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}
async function verifyPassword(password, encoded) {
  const parts = typeof encoded === 'string' ? encoded.split('$') : [];
  // Do not trust a stored hash to choose unbounded KDF resource parameters.
  const valid = parts.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$131072$8$1'
    && /^[A-Za-z0-9_-]{22}$/.test(parts[4]) && /^[A-Za-z0-9_-]{86}$/.test(parts[5]);
  const selected = valid ? parts : DUMMY_HASH.split('$');
  const expected = Buffer.from(selected[5], 'base64url');
  const derived = await scrypt(password, Buffer.from(selected[4], 'base64url'), 64, SCRYPT);
  return timingSafeEqual(derived, expected) && valid;
}

/** Account operations and opaque, revocable sessions, backed by PostgreSQL. */
export class AccountService {
  constructor(db, { sessionTtlSeconds = 604800, signupCredits = 0 } = {}) {
    positiveInteger(sessionTtlSeconds, 'sessionTtlSeconds', 2592000);
    if (!Number.isSafeInteger(signupCredits) || signupCredits < 0 || signupCredits > 2147483647) invalid('signupCredits must be a nonnegative integer.');
    this.db = db;
    this.sessionTtlSeconds = sessionTtlSeconds;
    this.signupCredits = signupCredits;
  }

  async register({ email: inputEmail, password: inputPassword, displayName } = {}) {
    const email = emailAddress(inputEmail);
    const password = passwordValue(inputPassword);
    const name = displayNameValue(displayName ?? email.split('@')[0]);
    const passwordHash = await hashPassword(password);
    return this.db.transaction(async (tx) => {
      let row;
      try {
        const result = await tx.query(`INSERT INTO knovid_users (id, email, display_name, password_hash, status, created_at, updated_at)
          VALUES ($1, $2, $3, $4, 'active', now(), now()) RETURNING ${USER_COLUMNS}`, [randomUUID(), email, name, passwordHash]);
        row = result.rows[0];
      } catch (error) {
        if (error.code === '23505') throw new AppError('EMAIL_EXISTS', 'An account with this email already exists.', 409);
        throw error;
      }
      await tx.query('INSERT INTO knovid_credit_accounts (user_id, balance, reserved, updated_at) VALUES ($1, 0, 0, now())', [row.id]);
      if (this.signupCredits > 0) {
        await grantInTransaction(tx, { userId: row.id, amount: this.signupCredits, idempotencyKey: `signup:${row.id}`, reason: 'signup' });
      }
      return this.issueSession(tx, row);
    });
  }

  async login({ email: inputEmail, password: inputPassword } = {}) {
    const email = emailAddress(inputEmail);
    const password = passwordValue(inputPassword, false);
    return this.db.transaction(async (tx) => {
      // Password changes/disable take the same row lock, preventing stale-password sessions.
      const { rows } = await tx.query(`SELECT ${USER_COLUMNS}, password_hash FROM knovid_users WHERE email = $1 FOR UPDATE`, [email]);
      const row = rows[0];
      const matches = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
      if (!row || !matches || row.status !== 'active') throw badCredentials();
      return this.issueSession(tx, row);
    });
  }

  async issueSession(tx, row) {
    const token = randomBytes(32).toString('base64url');
    await tx.query('DELETE FROM knovid_sessions WHERE user_id = $1 AND expires_at <= now()', [row.id]);
    // Keep at most ten sessions. Callers hold the user's row lock or just inserted it.
    await tx.query(`DELETE FROM knovid_sessions WHERE user_id = $1 AND token_hash IN
      (SELECT token_hash FROM knovid_sessions WHERE user_id = $1 ORDER BY created_at DESC, token_hash DESC OFFSET 9)`, [row.id]);
    const { rows } = await tx.query(`INSERT INTO knovid_sessions (token_hash, user_id, created_at, expires_at)
      VALUES ($1, $2, now(), now() + $3 * interval '1 second') RETURNING expires_at`, [sessionHash(token), row.id, this.sessionTtlSeconds]);
    return { user: publicUser(row), token, expiresAt: iso(rows[0].expires_at) };
  }

  async authenticate(token) {
    if (typeof token !== 'string' || !SESSION_TOKEN.test(token)) throw unauthenticated();
    const { rows } = await this.db.query(`SELECT u.id, u.email, u.display_name, u.status, u.created_at, u.updated_at
      FROM knovid_sessions s JOIN knovid_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`, [sessionHash(token)]);
    if (!rows[0]) throw unauthenticated();
    return publicUser(rows[0]);
  }

  async logout(token) {
    if (typeof token === 'string' && SESSION_TOKEN.test(token)) {
      await this.db.query('DELETE FROM knovid_sessions WHERE token_hash = $1', [sessionHash(token)]);
    }
  }

  async updateProfile(id, { displayName } = {}) {
    const { rows } = await this.db.query(`UPDATE knovid_users SET display_name = $2, updated_at = now()
      WHERE id = $1 AND status = 'active' RETURNING ${USER_COLUMNS}`, [userId(id), displayNameValue(displayName)]);
    if (!rows[0]) throw new AppError('ACCOUNT_UNAVAILABLE', 'Account is unavailable.', 404);
    return publicUser(rows[0]);
  }

  async changePassword(id, { currentPassword, newPassword } = {}) {
    userId(id);
    passwordValue(currentPassword, false);
    passwordValue(newPassword);
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query('SELECT password_hash, status FROM knovid_users WHERE id = $1 FOR UPDATE', [id]);
      const row = rows[0];
      const matches = await verifyPassword(currentPassword, row?.password_hash ?? DUMMY_HASH);
      if (!row || !matches || row.status !== 'active') throw badCredentials();
      const passwordHash = await hashPassword(newPassword);
      await tx.query('UPDATE knovid_users SET password_hash = $2, updated_at = now() WHERE id = $1', [id, passwordHash]);
      await tx.query('DELETE FROM knovid_sessions WHERE user_id = $1', [id]);
    });
  }

  /** Trusted administration only; never expose this to the ordinary account endpoint. */
  async setStatus(id, status) {
    userId(id);
    if (status !== 'active' && status !== 'disabled') invalid('Status must be active or disabled.');
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query(`UPDATE knovid_users SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${USER_COLUMNS}`, [id, status]);
      if (!rows[0]) throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.', 404);
      if (status === 'disabled') await tx.query('DELETE FROM knovid_sessions WHERE user_id = $1', [id]);
      return publicUser(rows[0]);
    });
  }

  /** Trusted administration; cursor uses UUID order and never includes secrets. */
  async listUsers({ limit = 20, before } = {}) {
    positiveInteger(limit, 'limit', 100);
    if (before !== undefined) userId(before);
    const { rows } = await this.db.query(`SELECT ${USER_COLUMNS} FROM knovid_users
      WHERE ($1::uuid IS NULL OR id < $1::uuid) ORDER BY id DESC LIMIT $2`, [before ?? null, limit + 1]);
    const page = rows.slice(0, limit);
    return { users: page.map(publicUser), nextCursor: rows.length > limit ? page.at(-1).id : null };
  }

  /** Atomic fixed-window throttling shared by all API processes. */
  async consumeRateLimit(key, { limit = 10, windowSeconds = 900 } = {}) {
    if (typeof key !== 'string' || key.length < 1 || key.length > 200) invalid('Rate-limit key must contain 1 to 200 characters.');
    positiveInteger(limit, 'limit', 1000000);
    positiveInteger(windowSeconds, 'windowSeconds', 86400);
    const { rows } = await this.db.query(`INSERT INTO knovid_auth_limits (key, window_start, attempts) VALUES ($1, now(), 1)
      ON CONFLICT (key) DO UPDATE SET
        attempts = CASE WHEN knovid_auth_limits.window_start + $2 * interval '1 second' <= now() THEN 1
          ELSE LEAST(knovid_auth_limits.attempts + 1, 1000001) END,
        window_start = CASE WHEN knovid_auth_limits.window_start + $2 * interval '1 second' <= now() THEN now()
          ELSE knovid_auth_limits.window_start END
      RETURNING attempts, window_start + $2 * interval '1 second' AS reset_at`, [key, windowSeconds]);
    const row = rows[0];
    if (row.attempts > limit) {
      const error = new AppError('RATE_LIMITED', 'Too many attempts. Please try again later.', 429);
      error.retryAfterSeconds = Math.max(1, Math.ceil((new Date(row.reset_at).getTime() - Date.now()) / 1000));
      throw error;
    }
    return { remaining: Math.max(0, limit - row.attempts), resetAt: iso(row.reset_at) };
  }
}
