import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.mjs';

/** Executes actual PostgreSQL SQL in WASM; live multi-connection tests are separate. */
export async function createTestDatabase() {
  const engine = new PGlite();
  await engine.waitReady;
  const queryOn = (connection) => async (sql, params = []) => {
    // Match pg's simple-query support for arbitrary multi-statement migrations.
    const result = params.length
      ? await connection.query(sql, params)
      : (await connection.exec(sql)).at(-1) ?? { rows: [] };
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const db = {
    query: queryOn(engine),
    transaction: (work) => engine.transaction(async (tx) => work({
      query: queryOn(tx),
    })),
    close: () => engine.close(),
  };
  await migrate(db);
  return { db, close: () => db.close() };
}
