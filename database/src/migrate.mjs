import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const migrationDirectory = new URL('../migrations/', import.meta.url);

/** Run once at deployment; checksums prevent silently changing applied migrations. */
export async function migrate(db) {
  const files = (await readdir(migrationDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(674213019)');
    await tx.query(`CREATE TABLE IF NOT EXISTS knovid_schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Map((await tx.query('SELECT name, checksum FROM knovid_schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    const added = [];
    for (const name of files) {
      const sql = await readFile(new URL(name, migrationDirectory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(name)) {
        if (applied.get(name) !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await tx.query(sql);
      await tx.query('INSERT INTO knovid_schema_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
      added.push(name);
    }
    return added;
  });
}
