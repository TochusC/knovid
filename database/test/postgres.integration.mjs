import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CreditService } from '../src/credits.mjs';
import { ProjectAccessService } from '../src/access.mjs';
import { migrate } from '../src/migrate.mjs';

test('PostgreSQL multi-connection integration', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to a local test PostgreSQL database.',
}, async (t) => {
  const { createDatabase } = await import('../src/db.mjs');
  // This generated identifier is the only schema the suite creates or drops.
  const schema = `knovid_test_${randomUUID().replaceAll('-', '')}`;
  const admin = createDatabase({ connectionString: process.env.TEST_DATABASE_URL });
  let db;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = createDatabase({ connectionString: process.env.TEST_DATABASE_URL, max: 20, options: `-c search_path=${schema}` });
    await migrate(db);
    const credits = new CreditService(db);
    const projects = new ProjectAccessService(db);

    async function fixture() {
      const userId = randomUUID();
      const projectId = `project-${randomUUID()}`;
      await db.query(`INSERT INTO knovid_users(id,email,display_name,password_hash)
        VALUES ($1,$2,'Postgres test','unused-test-hash')`, [userId, `${userId}@example.test`]);
      await db.query('INSERT INTO knovid_credit_accounts(user_id) VALUES ($1)', [userId]);
      await projects.bind({ userId, projectId });
      await credits.grant({ userId, amount: 100, idempotencyKey: 'initial', reason: 'test grant' });
      return { userId, projectId };
    }

    async function reconcile(userId) {
      const balance = await credits.getBalance(userId);
      const row = (await db.query(`SELECT COALESCE(sum(delta_balance),0) AS balance,
        COALESCE(sum(delta_reserved),0) AS reserved FROM knovid_credit_ledger WHERE user_id=$1`, [userId])).rows[0];
      const held = (await db.query(`SELECT COALESCE(sum(amount),0) AS amount
        FROM knovid_credit_reservations WHERE user_id=$1 AND state='reserved'`, [userId])).rows[0];
      assert.equal(balance.balance, Number(row.balance));
      assert.equal(balance.reserved, Number(row.reserved));
      assert.equal(balance.reserved, Number(held.amount));
      assert.ok(balance.available >= 0);
    }

    await t.test('twenty concurrent reservations cannot overspend one account', async () => {
      const owner = await fixture();
      const results = await Promise.allSettled(Array.from({ length: 20 }, (_, n) => credits.reserve({
        ...owner, operationKey: `job-${n}`, amount: 10, revision: 1,
      })));
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 10);
      const failures = results.filter((result) => result.status === 'rejected');
      assert.equal(failures.length, 10);
      assert.ok(failures.every((result) => result.reason.code === 'INSUFFICIENT_CREDITS'));
      assert.deepEqual(await credits.getBalance(owner.userId), { balance: 100, reserved: 100, available: 0 });
      await reconcile(owner.userId);
    });

    await t.test('concurrent duplicate grants and captures each append once', async () => {
      const owner = await fixture();
      const grant = { userId: owner.userId, amount: 20, idempotencyKey: 'parallel-grant', reason: 'parallel grant' };
      const grants = await Promise.all(Array.from({ length: 12 }, () => credits.grant(grant)));
      assert.equal(new Set(grants.map((entry) => String(entry.id))).size, 1);
      const reserve = { ...owner, operationKey: 'parallel-capture', amount: 50, revision: 1 };
      const reservations = await Promise.all(Array.from({ length: 12 }, () => credits.reserve(reserve)));
      assert.equal(new Set(reservations.map((entry) => entry.id)).size, 1);
      const captures = await Promise.all(Array.from({ length: 12 }, () => credits.capture({
        userId: owner.userId, operationKey: reserve.operationKey, amount: 35,
      })));
      assert.equal(new Set(captures.map((entry) => entry.id)).size, 1);
      assert.deepEqual(await credits.getBalance(owner.userId), { balance: 85, reserved: 0, available: 85 });
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM knovid_credit_ledger WHERE user_id=$1 AND kind='capture'", [owner.userId])).rows[0].n), 1);
      await reconcile(owner.userId);
    });

    await t.test('capture racing cancellation has exactly one terminal outcome', async () => {
      const owner = await fixture();
      const input = { ...owner, operationKey: 'capture-or-release', amount: 50, revision: 1 };
      await credits.reserve(input);
      const results = await Promise.allSettled([
        credits.capture({ userId: owner.userId, operationKey: input.operationKey, amount: 30 }),
        credits.release({ userId: owner.userId, operationKey: input.operationKey }),
      ]);
      const successes = results.filter((result) => result.status === 'fulfilled');
      const failures = results.filter((result) => result.status === 'rejected');
      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].reason.code, 'RESERVATION_CLOSED');
      assert.deepEqual(await credits.getBalance(owner.userId), {
        balance: successes[0].value.state === 'captured' ? 70 : 100,
        reserved: 0,
        available: successes[0].value.state === 'captured' ? 70 : 100,
      });
      await reconcile(owner.userId);
    });

    await t.test('transaction rollback and migration rerun preserve persisted state', async () => {
      const owner = await fixture();
      const marker = new Error('test rollback');
      await assert.rejects(db.transaction(async (tx) => {
        await tx.query('UPDATE knovid_credit_accounts SET balance=0 WHERE user_id=$1', [owner.userId]);
        throw marker;
      }), (error) => error === marker);
      assert.deepEqual(await migrate(db), []);
      assert.deepEqual(await credits.getBalance(owner.userId), { balance: 100, reserved: 0, available: 100 });
      const freshConnection = createDatabase({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
      try {
        assert.deepEqual(await new CreditService(freshConnection).getBalance(owner.userId), { balance: 100, reserved: 0, available: 100 });
      } finally {
        await freshConnection.close();
      }
      await reconcile(owner.userId);
    });
  } finally {
    await db?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.close();
  }
});
