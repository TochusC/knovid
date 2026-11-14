import { createDatabase, migrate, AccountService, CreditService, AppError } from './index.mjs';

const help = `KnoVid account administration (trusted database operator only)
  npm run migrate
  npm run admin -- users [--limit 20] [--before USER_ID]
  npm run admin -- balance --user USER_ID
  npm run admin -- grant --user USER_ID --amount 100 --key UNIQUE_EVENT_ID --reason "Manual grant"
  npm run admin -- disable --user USER_ID
  npm run admin -- enable --user USER_ID
  npm run admin -- audit
  npm run admin -- pending [--limit 100]

Credit is an integer product unit. Reuse --key when retrying a grant.
No passwords, automatic demo accounts, paid subscriptions or payment callbacks are seeded.`;

const [command, ...rawArgs] = process.argv.slice(2);
if (!command || command === '--help' || command === 'help') {
  console.log(help);
} else {
  let db;
  try {
    const fields = new Map([
      ['migrate', []], ['users', ['limit', 'before']], ['balance', ['user']],
      ['grant', ['user', 'amount', 'key', 'reason']], ['disable', ['user']], ['enable', ['user']],
      ['audit', []], ['pending', ['limit']],
    ]);
    if (!fields.has(command)) throw new AppError('INVALID_INPUT', 'Unknown command. Use --help.');
    const args = {};
    for (let i = 0; i < rawArgs.length; i += 2) {
      const name = rawArgs[i].replace(/^--/, '');
      if (!rawArgs[i].startsWith('--') || !fields.get(command).includes(name) || name in args || rawArgs[i + 1] === undefined) {
        throw new AppError('INVALID_INPUT', 'Invalid command options. Use --help.');
      }
      args[name] = rawArgs[i + 1];
    }
    db = createDatabase({ connectionString: process.env.DATABASE_URL });
    const accounts = new AccountService(db);
    const credits = new CreditService(db);
    let result;
    switch (command) {
      case 'migrate': result = { applied: await migrate(db) }; break;
      case 'users': result = await accounts.listUsers({ limit: Number(args.limit ?? 20), before: args.before }); break;
      case 'balance': result = await credits.getBalance(args.user); break;
      case 'grant': result = await credits.grant({ userId: args.user, amount: Number(args.amount), idempotencyKey: args.key, reason: args.reason }); break;
      case 'disable': case 'enable': result = await accounts.setStatus(args.user, command === 'disable' ? 'disabled' : 'active'); break;
      case 'pending': {
        const limit = Number(args.limit ?? 100);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new AppError('INVALID_INPUT', 'limit must be 1..1000.');
        result = (await db.query(`SELECT id,user_id,operation_key,project_id,revision,revision_id,scene_id,amount,created_at
          FROM knovid_credit_reservations WHERE state='reserved' ORDER BY created_at LIMIT $1`, [limit])).rows;
        break;
      }
      case 'audit': {
        const { rows } = await db.query(`SELECT a.user_id,a.balance,a.reserved,
          COALESCE(l.b,0)::text AS ledger_balance,COALESCE(l.r,0)::text AS ledger_reserved,
          COALESCE(h.r,0)::text AS pending_reserved
          FROM knovid_credit_accounts a
          LEFT JOIN (SELECT user_id,SUM(delta_balance) b,SUM(delta_reserved) r FROM knovid_credit_ledger GROUP BY user_id) l USING(user_id)
          LEFT JOIN (SELECT user_id,SUM(amount) r FROM knovid_credit_reservations WHERE state='reserved' GROUP BY user_id) h USING(user_id)
          WHERE a.balance<>COALESCE(l.b,0) OR a.reserved<>COALESCE(l.r,0) OR a.reserved<>COALESCE(h.r,0)`);
        result = { ok: rows.length === 0, mismatches: rows };
        if (rows.length) process.exitCode = 1;
        break;
      }
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof AppError ? `${error.code}: ${error.message}` : `Database operation failed (${error.code ?? error.name}). Check configuration; no changes should be assumed.`);
    process.exitCode = 1;
  } finally { await db?.close(); }
}
