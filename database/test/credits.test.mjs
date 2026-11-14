import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CreditService } from '../src/credits.mjs';
import { ProjectAccessService } from '../src/access.mjs';
import { migrate } from '../src/migrate.mjs';
import { createTestDatabase } from './support.mjs';

let db;
let close;
let credits;
let projects;

before(async () => {
  ({ db, close } = await createTestDatabase());
  credits = new CreditService(db);
  projects = new ProjectAccessService(db);
});
after(async () => close?.());

async function fixture(balance = 100) {
  const userId = randomUUID();
  const projectId = `project-${randomUUID()}`;
  await db.query(`INSERT INTO knovid_users(id,email,display_name,password_hash)
    VALUES ($1,$2,'Credit test','unused-test-hash')`, [userId, `${userId}@example.test`]);
  await db.query('INSERT INTO knovid_credit_accounts(user_id) VALUES ($1)', [userId]);
  await projects.bind({ userId, projectId });
  if (balance) {
    await credits.grant({ userId, amount: balance, idempotencyKey: 'initial', reason: 'test allocation' });
  }
  return { userId, projectId };
}

const hasCode = (code) => (error) => error.code === code;
const reservationInput = (owner, extra = {}) => ({ ...owner, operationKey: 'render:revision-1', amount: 40, revision: 1, ...extra });

async function assertReconciled(userId) {
  const account = await credits.getBalance(userId);
  const ledger = (await db.query(`SELECT COALESCE(sum(delta_balance),0) AS balance,
    COALESCE(sum(delta_reserved),0) AS reserved FROM knovid_credit_ledger WHERE user_id=$1`, [userId])).rows[0];
  const holds = (await db.query(`SELECT COALESCE(sum(amount),0) AS amount
    FROM knovid_credit_reservations WHERE user_id=$1 AND state='reserved'`, [userId])).rows[0];
  assert.equal(account.balance, Number(ledger.balance));
  assert.equal(account.reserved, Number(ledger.reserved));
  assert.equal(account.reserved, Number(holds.amount));
  assert.equal(account.available, account.balance - account.reserved);
  assert.ok(account.available >= 0);
}

test('migration rerun does not change existing balances or ledger', async () => {
  const { userId } = await fixture();
  assert.deepEqual(await migrate(db), []);
  assert.deepEqual(await credits.getBalance(userId), { balance: 100, reserved: 0, available: 100 });
  await assertReconciled(userId);
});

test('grant is idempotent and rejects a changed amount or reason', async () => {
  const { userId } = await fixture(0);
  const input = { userId, amount: 100, idempotencyKey: 'allocation-1', reason: 'manual test grant' };
  const first = await credits.grant(input);
  const repeated = await credits.grant(input);
  assert.equal(String(first.id), String(repeated.id));
  assert.equal(first.deltaBalance, 100);
  await assert.rejects(credits.grant({ ...input, amount: 101 }), hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(credits.grant({ ...input, reason: 'changed reason' }), hasCode('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(await credits.getBalance(userId), { balance: 100, reserved: 0, available: 100 });
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM knovid_credit_ledger WHERE user_id=$1', [userId])).rows[0].n), 1);
  await assertReconciled(userId);
});

test('reservation holds funds, partial capture charges actual usage and releases the difference', async () => {
  const owner = await fixture();
  const input = reservationInput(owner);
  const held = await credits.reserve(input);
  assert.equal(held.state, 'reserved');
  assert.equal(held.amount, 40);
  assert.deepEqual(await credits.getBalance(owner.userId), { balance: 100, reserved: 40, available: 60 });
  const repeated = await credits.reserve(input);
  assert.equal(repeated.id, held.id);
  const captured = await credits.capture({ userId: owner.userId, operationKey: input.operationKey, amount: 25 });
  assert.equal(captured.state, 'captured');
  assert.equal(captured.capturedAmount, 25);
  assert.deepEqual(await credits.getBalance(owner.userId), { balance: 75, reserved: 0, available: 75 });
  assert.equal((await credits.reserve(input)).state, 'captured');
  assert.equal((await credits.capture({ userId: owner.userId, operationKey: input.operationKey, amount: 25 })).id, held.id);
  await assert.rejects(credits.capture({ userId: owner.userId, operationKey: input.operationKey, amount: 26 }), hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(credits.release({ userId: owner.userId, operationKey: input.operationKey }), hasCode('RESERVATION_CLOSED'));
  const { entries } = await credits.listLedger(owner.userId);
  assert.equal(entries.length, 3);
  assert.equal(entries.filter((entry) => entry.kind === 'capture').length, 1);
  await assertReconciled(owner.userId);
});

test('a cancelled or failed task releases its hold once without minting credits', async () => {
  const owner = await fixture();
  const input = reservationInput(owner);
  await credits.reserve(input);
  const released = await credits.release({ userId: owner.userId, operationKey: input.operationKey });
  assert.equal(released.state, 'released');
  assert.equal((await credits.release({ userId: owner.userId, operationKey: input.operationKey })).id, released.id);
  assert.equal((await credits.reserve(input)).state, 'released');
  await assert.rejects(credits.capture({ userId: owner.userId, operationKey: input.operationKey, amount: 10 }), hasCode('RESERVATION_CLOSED'));
  assert.deepEqual(await credits.getBalance(owner.userId), { balance: 100, reserved: 0, available: 100 });
  await assertReconciled(owner.userId);
});

test('zero-cost completion releases the hold through a terminal capture', async () => {
  const owner = await fixture();
  const input = reservationInput(owner);
  await credits.reserve(input);
  const captured = await credits.capture({ userId: owner.userId, operationKey: input.operationKey, amount: 0 });
  assert.equal(captured.capturedAmount, 0);
  assert.equal(captured.state, 'captured');
  assert.deepEqual(await credits.getBalance(owner.userId), { balance: 100, reserved: 0, available: 100 });
  await assertReconciled(owner.userId);
});

test('a retry cannot silently change reservation amount, project, revision, or scene', async () => {
  const owner = await fixture();
  const input = reservationInput(owner, { sceneId: 'scene-1' });
  await credits.reserve(input);
  const secondProject = `project-${randomUUID()}`;
  await projects.bind({ userId: owner.userId, projectId: secondProject });
  for (const change of [{ amount: 41 }, { revision: 2 }, { projectId: secondProject }, { sceneId: 'scene-2' }]) {
    await assert.rejects(credits.reserve({ ...input, ...change }), hasCode('IDEMPOTENCY_CONFLICT'));
  }
  assert.deepEqual(await credits.getBalance(owner.userId), { balance: 100, reserved: 40, available: 60 });
  await assertReconciled(owner.userId);
});

test('exact backend revision IDs work without a numeric revision and cannot change on retry', async () => {
  const owner = await fixture();
  const revisionId = `revision-${randomUUID()}`;
  const input = { ...owner, operationKey: 'exact-revision-job', amount: 40, revisionId, sceneId: 'scene-1' };
  const held = await credits.reserve(input);
  assert.equal(held.revisionId, revisionId);
  assert.equal(held.revision, null);
  assert.equal((await credits.reserve(input)).id, held.id);
  await assert.rejects(credits.reserve({ ...input, revisionId: `revision-${randomUUID()}` }), hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(credits.reserve({ ...input, revision: 1 }), hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(credits.reserve({ ...input, operationKey: 'no-revision', revisionId: undefined }), hasCode('INVALID_INPUT'));
  const combined = await credits.reserve({ ...input, operationKey: 'both-revisions', amount: 10, revision: 2 });
  assert.equal(combined.revisionId, revisionId);
  assert.equal(combined.revision, 2);
  assert.deepEqual(await credits.getBalance(owner.userId), { balance: 100, reserved: 50, available: 50 });
  await assertReconciled(owner.userId);
});

test('insufficient funds and over-capture leave both wallet and ledger unchanged', async () => {
  const owner = await fixture();
  const input = reservationInput(owner, { amount: 80 });
  await credits.reserve(input);
  await assert.rejects(credits.reserve(reservationInput(owner, { operationKey: 'other-work', amount: 21 })), hasCode('INSUFFICIENT_CREDITS'));
  await assert.rejects(credits.capture({ userId: owner.userId, operationKey: input.operationKey, amount: 81 }));
  assert.deepEqual(await credits.getBalance(owner.userId), { balance: 100, reserved: 80, available: 20 });
  assert.equal((await credits.listLedger(owner.userId)).entries.length, 2);
  await assertReconciled(owner.userId);
});

test('parallel requests against the embedded engine preserve credit invariants', async () => {
  // PGlite serializes connections; postgres.integration.mjs verifies actual row-lock races.
  const owner = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, n) =>
    credits.reserve(reservationInput(owner, { operationKey: `parallel-${n}`, amount: 30 }))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3);
  for (const result of results.filter((result) => result.status === 'rejected')) {
    assert.equal(result.reason.code, 'INSUFFICIENT_CREDITS');
  }
  assert.deepEqual(await credits.getBalance(owner.userId), { balance: 100, reserved: 90, available: 10 });
  await assertReconciled(owner.userId);
});

test('capture and release have exactly one terminal winner', async () => {
  const owner = await fixture();
  const input = reservationInput(owner);
  await credits.reserve(input);
  const results = await Promise.allSettled([
    credits.capture({ userId: owner.userId, operationKey: input.operationKey, amount: 25 }),
    credits.release({ userId: owner.userId, operationKey: input.operationKey }),
  ]);
  const successes = results.filter((result) => result.status === 'fulfilled');
  const failures = results.filter((result) => result.status === 'rejected');
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason.code, 'RESERVATION_CLOSED');
  assert.equal((await credits.getBalance(owner.userId)).balance, successes[0].value.state === 'captured' ? 75 : 100);
  await assertReconciled(owner.userId);
});

test('project ownership and ledger pagination cannot leak another account', async () => {
  const owner = await fixture();
  const other = await fixture(0);
  const input = reservationInput(owner);
  await credits.reserve(input);
  await assert.rejects(projects.requireOwner({ userId: other.userId, projectId: owner.projectId }), hasCode('NOT_FOUND'));
  await assert.rejects(projects.bind({ userId: other.userId, projectId: owner.projectId }));
  await assert.rejects(credits.reserve({ ...input, userId: other.userId }), hasCode('NOT_FOUND'));
  await assert.rejects(credits.capture({ userId: other.userId, operationKey: input.operationKey, amount: 1 }), hasCode('NOT_FOUND'));
  await assert.rejects(credits.release({ userId: other.userId, operationKey: input.operationKey }), hasCode('NOT_FOUND'));
  assert.deepEqual((await credits.listLedger(other.userId)).entries, []);
  assert.deepEqual(await projects.listProjectIds(other.userId), [other.projectId]);
  const first = await credits.listLedger(owner.userId, { limit: 1 });
  assert.equal(first.entries.length, 1);
  assert.ok(first.nextCursor);
  const second = await credits.listLedger(owner.userId, { limit: 1, before: first.nextCursor });
  assert.equal(second.entries.length, 1);
  assert.notEqual(String(first.entries[0].id), String(second.entries[0].id));
  assert.equal(second.nextCursor, null);
  assert.deepEqual((await credits.listLedger(other.userId, { before: first.nextCursor })).entries, []);
  await assertReconciled(owner.userId);
  await assertReconciled(other.userId);
});

test('disabled accounts cannot start new billed work', async () => {
  const owner = await fixture();
  await db.query("UPDATE knovid_users SET status='disabled' WHERE id=$1", [owner.userId]);
  await assert.rejects(credits.reserve(reservationInput(owner)), hasCode('ACCOUNT_DISABLED'));
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM knovid_credit_reservations WHERE user_id=$1', [owner.userId])).rows[0].n), 0);
});

test('disabled accounts can replay existing reservations but cannot create a new one', async () => {
  const owner = await fixture();
  const input = reservationInput(owner);
  const held = await credits.reserve(input);
  await db.query("UPDATE knovid_users SET status='disabled' WHERE id=$1", [owner.userId]);
  const repeated = await credits.reserve(input);
  assert.equal(repeated.id, held.id);
  assert.equal(repeated.state, 'reserved');
  await assert.rejects(credits.reserve({ ...input, amount: 41 }), hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(credits.reserve({ ...input, operationKey: 'new-disabled-work' }), hasCode('ACCOUNT_DISABLED'));
  await credits.capture({ userId: owner.userId, operationKey: input.operationKey, amount: 25 });
  const completed = await credits.reserve(input);
  assert.equal(completed.id, held.id);
  assert.equal(completed.state, 'captured');
  assert.equal(completed.capturedAmount, 25);
  assert.deepEqual(await credits.getBalance(owner.userId), { balance: 75, reserved: 0, available: 75 });
  assert.equal((await credits.listLedger(owner.userId)).entries.length, 3);
  await assertReconciled(owner.userId);
});

test('disabling an account still allows already-running work to settle or release', async () => {
  const owner = await fixture();
  await credits.reserve(reservationInput(owner, { operationKey: 'finishing-task', amount: 40 }));
  await credits.reserve(reservationInput(owner, { operationKey: 'cancelled-task', amount: 20 }));
  await db.query("UPDATE knovid_users SET status='disabled' WHERE id=$1", [owner.userId]);
  assert.equal((await credits.capture({ userId: owner.userId, operationKey: 'finishing-task', amount: 30 })).state, 'captured');
  assert.equal((await credits.release({ userId: owner.userId, operationKey: 'cancelled-task' })).state, 'released');
  assert.deepEqual(await credits.getBalance(owner.userId), { balance: 70, reserved: 0, available: 70 });
  await assertReconciled(owner.userId);
});

test('a failed ledger insert rolls back both wallet change and new reservation', async () => {
  const owner = await fixture();
  const injectedError = new Error('Simulated ledger write failure');
  const failingDatabase = {
    transaction: (work) => db.transaction((tx) => work({
      query: (sql, params) => {
        if (/INSERT INTO knovid_credit_ledger/.test(sql)) throw injectedError;
        return tx.query(sql, params);
      },
    })),
  };
  await assert.rejects(new CreditService(failingDatabase).reserve(reservationInput(owner)), (error) => error === injectedError);
  assert.deepEqual(await credits.getBalance(owner.userId), { balance: 100, reserved: 0, available: 100 });
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM knovid_credit_reservations WHERE user_id=$1', [owner.userId])).rows[0].n), 0);
  assert.equal((await credits.listLedger(owner.userId)).entries.length, 1);
  // The same stable operation key remains usable after the rolled-back attempt.
  assert.equal((await credits.reserve(reservationInput(owner))).state, 'reserved');
  await assertReconciled(owner.userId);
});

test('amount bounds and integer overflow reject without creating partial ledger entries', async () => {
  const owner = await fixture(0);
  for (const amount of [-1, 0, 0.5, NaN, Infinity, '10', 2_147_483_648]) {
    await assert.rejects(credits.grant({ userId: owner.userId, amount, idempotencyKey: 'invalid', reason: 'test' }), hasCode('INVALID_AMOUNT'));
    await assert.rejects(credits.reserve(reservationInput(owner, { amount })), hasCode('INVALID_AMOUNT'));
  }
  await credits.grant({ userId: owner.userId, amount: 2_147_483_647, idempotencyKey: 'max', reason: 'boundary test' });
  await assert.rejects(credits.grant({ userId: owner.userId, amount: 1, idempotencyKey: 'overflow', reason: 'overflow test' }));
  assert.deepEqual(await credits.getBalance(owner.userId), { balance: 2_147_483_647, reserved: 0, available: 2_147_483_647 });
  assert.equal((await credits.listLedger(owner.userId)).entries.length, 1);
  await assertReconciled(owner.userId);
});

test('ledger UPDATE, DELETE and TRUNCATE are rejected by PostgreSQL', async () => {
  const { userId } = await fixture();
  await assert.rejects(db.query("UPDATE knovid_credit_ledger SET reason='tampered' WHERE user_id=$1", [userId]), hasCode('55000'));
  await assert.rejects(db.query('DELETE FROM knovid_credit_ledger WHERE user_id=$1', [userId]), hasCode('55000'));
  await assert.rejects(db.query('TRUNCATE knovid_credit_ledger'), hasCode('55000'));
  await assertReconciled(userId);
});
