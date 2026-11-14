import pg from 'pg';

/** A pool-backed connection; each transaction pins one connection. */
export function createDatabase({ connectionString, max = 10, options } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  const pool = new pg.Pool({ connectionString, max, options, connectionTimeoutMillis: 5000 });
  // Avoid logging connection strings/credentials if an idle connection breaks.
  pool.on('error', () => console.error('KnoVid database: idle connection failed.'));
  return {
    query: (sql, params = []) => pool.query(sql, params),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '30s'");
        const result = await work({ query: (sql, params = []) => client.query(sql, params) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
