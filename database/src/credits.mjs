import { randomUUID } from 'node:crypto';
import { AppError, creditAmount, pageLimit, requiredText, uuid } from './errors.mjs';

const iso = (value) => new Date(value).toISOString();
const snapshot = (row) => ({ balance: row.balance, reserved: row.reserved, available: row.balance - row.reserved });
const reservation = (row) => ({
  id: row.id, userId: row.user_id, operationKey: row.operation_key,
  projectId: row.project_id, revision: row.revision, revisionId: row.revision_id, sceneId: row.scene_id,
  amount: row.amount, capturedAmount: row.captured_amount, state: row.state,
  createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});
const ledgerEntry = (row) => ({
  id: String(row.id), kind: row.kind, reservationId: row.reservation_id,
  deltaBalance: row.delta_balance, deltaReserved: row.delta_reserved,
  balanceAfter: row.balance_after, reservedAfter: row.reserved_after,
  reason: row.reason, createdAt: iso(row.created_at),
});
const conflict = () => new AppError('IDEMPOTENCY_CONFLICT', '同一请求标识不能使用不同参数。', 409);

async function lockWallet(tx, userId, { requireActive = false } = {}) {
  uuid(userId);
  // Every writer locks user then wallet, then reservation: one lock order across services.
  const { rows: [user] } = await tx.query('SELECT status FROM knovid_users WHERE id=$1 FOR UPDATE', [userId]);
  if (!user) throw new AppError('NOT_FOUND', '账号不存在。', 404);
  if (requireActive && user.status !== 'active') throw new AppError('ACCOUNT_DISABLED', '账号已停用。', 403);
  const { rows: [wallet] } = await tx.query('SELECT * FROM knovid_credit_accounts WHERE user_id=$1 FOR UPDATE', [userId]);
  if (!wallet) throw new AppError('NOT_FOUND', 'Credit 账户不存在。', 404);
  return wallet;
}

async function writeEvent(tx, { userId, eventKey, kind, reservationId = null, deltaBalance, deltaReserved, reason }) {
  const { rows: [wallet] } = await tx.query(`UPDATE knovid_credit_accounts
    SET balance=balance+$2,reserved=reserved+$3,updated_at=now()
    WHERE user_id=$1 RETURNING *`, [userId, deltaBalance, deltaReserved]);
  const { rows: [entry] } = await tx.query(`INSERT INTO knovid_credit_ledger
    (user_id,event_key,kind,reservation_id,delta_balance,delta_reserved,balance_after,reserved_after,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
  [userId, eventKey, kind, reservationId, deltaBalance, deltaReserved, wallet.balance, wallet.reserved, reason]);
  return ledgerEntry(entry);
}

/** For signup inside the account creation transaction; not a browser API. */
export async function grantInTransaction(tx, { userId, amount, idempotencyKey, reason }) {
  creditAmount(amount);
  idempotencyKey = requiredText(idempotencyKey, 'idempotencyKey');
  reason = requiredText(reason, 'reason', 500);
  const wallet = await lockWallet(tx, userId);
  const eventKey = `grant:${idempotencyKey}`;
  const { rows: [existing] } = await tx.query('SELECT * FROM knovid_credit_ledger WHERE user_id=$1 AND event_key=$2', [userId, eventKey]);
  if (existing) {
    if (existing.delta_balance !== amount || existing.reason !== reason) throw conflict();
    return ledgerEntry(existing);
  }
  if (wallet.balance + amount > 2_147_483_647) throw new AppError('INVALID_AMOUNT', 'Credit 余额超出支持范围。');
  return writeEvent(tx, { userId, eventKey, kind: 'grant', deltaBalance: amount, deltaReserved: 0, reason });
}

/** Integer product credits. All writes are atomic, serialized per wallet, and idempotent. */
export class CreditService {
  constructor(db) { this.db = db; }

  async getBalance(userId) {
    uuid(userId);
    const { rows: [wallet] } = await this.db.query('SELECT balance,reserved FROM knovid_credit_accounts WHERE user_id=$1', [userId]);
    if (!wallet) throw new AppError('NOT_FOUND', 'Credit 账户不存在。', 404);
    return snapshot(wallet);
  }

  async listLedger(userId, { limit = 20, before } = {}) {
    uuid(userId);
    pageLimit(limit);
    if (before !== undefined && (typeof before !== 'string' || !/^[1-9][0-9]{0,18}$/.test(before) || BigInt(before) > 9223372036854775807n)) {
      throw new AppError('INVALID_INPUT', '分页游标无效。');
    }
    const { rows } = await this.db.query(`SELECT * FROM knovid_credit_ledger
      WHERE user_id=$1 AND ($2::bigint IS NULL OR id<$2::bigint) ORDER BY id DESC LIMIT $3`, [userId, before ?? null, limit + 1]);
    const entries = rows.slice(0, limit).map(ledgerEntry);
    return { entries, nextCursor: rows.length > limit ? entries.at(-1).id : null };
  }

  grant(input) { return this.db.transaction((tx) => grantInTransaction(tx, input)); }

  async reserve({ userId, operationKey, amount, projectId, revision, revisionId, sceneId }) {
    creditAmount(amount);
    operationKey = requiredText(operationKey, 'operationKey');
    projectId = requiredText(projectId, 'projectId');
    sceneId = sceneId == null ? null : requiredText(sceneId, 'sceneId');
    revision = revision ?? null;
    revisionId = revisionId == null ? null : requiredText(revisionId, 'revisionId');
    if ((revision === null && revisionId === null) || (revision !== null && (!Number.isInteger(revision) || revision < 1 || revision > 2_147_483_647))) {
      throw new AppError('INVALID_INPUT', '须提供有效的项目 revisionId 或版本序号。');
    }
    return this.db.transaction(async (tx) => {
      const wallet = await lockWallet(tx, userId);
      const { rows: [owner] } = await tx.query('SELECT user_id FROM knovid_project_owners WHERE project_id=$1', [projectId]);
      if (owner?.user_id !== userId) throw new AppError('NOT_FOUND', '项目不存在。', 404);
      const { rows: [existing] } = await tx.query('SELECT * FROM knovid_credit_reservations WHERE user_id=$1 AND operation_key=$2', [userId, operationKey]);
      if (existing) {
        if (existing.amount !== amount || existing.project_id !== projectId || existing.revision !== revision || existing.revision_id !== revisionId || existing.scene_id !== sceneId) throw conflict();
        return reservation(existing);
      }
      const { rows: [user] } = await tx.query('SELECT status FROM knovid_users WHERE id=$1', [userId]);
      if (user.status !== 'active') throw new AppError('ACCOUNT_DISABLED', '账号已停用。', 403);
      if (wallet.balance - wallet.reserved < amount) throw new AppError('INSUFFICIENT_CREDITS', '可用 Credit 不足。', 402);
      const { rows: [row] } = await tx.query(`INSERT INTO knovid_credit_reservations
        (id,user_id,operation_key,project_id,revision,scene_id,amount,revision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [randomUUID(), userId, operationKey, projectId, revision, sceneId, amount, revisionId]);
      await writeEvent(tx, { userId, eventKey: `reserve:${row.id}`, kind: 'reserve', reservationId: row.id,
        deltaBalance: 0, deltaReserved: amount, reason: '任务预留' });
      return reservation(row);
    });
  }

  async capture({ userId, operationKey, amount, expectedAmount }) {
    creditAmount(amount, { allowZero: true });
    return this.#finish({ userId, operationKey, amount, expectedAmount, state: 'captured' });
  }

  async release({ userId, operationKey, expectedAmount, unstarted }) {
    if (unstarted) {
      creditAmount(expectedAmount);
      unstarted = {projectId: requiredText(unstarted.projectId, 'projectId'), revisionId: requiredText(unstarted.revisionId, 'revisionId')};
    }
    return this.#finish({ userId, operationKey, expectedAmount, unstarted, state: 'released' });
  }

  async #finish({ userId, operationKey, amount, expectedAmount, unstarted, state }) {
    operationKey = requiredText(operationKey, 'operationKey');
    return this.db.transaction(async (tx) => {
      // Existing work must be settled/released even after an account is disabled.
      await lockWallet(tx, userId);
      const { rows: [row] } = await tx.query('SELECT * FROM knovid_credit_reservations WHERE user_id=$1 AND operation_key=$2 FOR UPDATE', [userId, operationKey]);
      if (!row) {
        if (unstarted) {
          // A cancellation can arrive before a pending reserve. Record the
          // closed operation under the same wallet lock without moving credits.
          const { rows: [closed] } = await tx.query(`INSERT INTO knovid_credit_reservations
            (id,user_id,operation_key,project_id,revision_id,amount,state) VALUES($1,$2,$3,$4,$5,$6,'released') RETURNING *`,
          [randomUUID(), userId, operationKey, unstarted.projectId, unstarted.revisionId, expectedAmount]);
          return reservation(closed);
        }
        throw new AppError('NOT_FOUND', '预留记录不存在。', 404);
      }
      if (expectedAmount !== undefined && row.amount !== expectedAmount) throw conflict();
      if (row.state === state) {
        if (state === 'captured' && row.captured_amount !== amount) throw conflict();
        return reservation(row);
      }
      if (row.state !== 'reserved') throw new AppError('RESERVATION_CLOSED', '该任务已完成结算或释放。', 409);
      if (state === 'captured' && amount > row.amount) throw new AppError('INVALID_AMOUNT', '实际消费不能超过预留额度。');
      const { rows: [updated] } = await tx.query(`UPDATE knovid_credit_reservations
        SET state=$3,captured_amount=$4,updated_at=now() WHERE user_id=$1 AND operation_key=$2 RETURNING *`,
      [userId, operationKey, state, state === 'captured' ? amount : null]);
      await writeEvent(tx, { userId, eventKey: `${state === 'captured' ? 'capture' : 'release'}:${row.id}`,
        kind: state === 'captured' ? 'capture' : 'release', reservationId: row.id,
        deltaBalance: state === 'captured' ? -amount : 0, deltaReserved: -row.amount,
        reason: state === 'captured' ? '任务结算' : '任务取消或最终失败，释放额度' });
      return reservation(updated);
    });
  }
}
