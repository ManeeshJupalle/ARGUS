import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceStatus } from '@argus/shared';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '..', '..', 'data');
const SCHEMA_PATH = join(here, 'schema.sql');

export const DB_PATH = join(DATA_DIR, 'argus.db');

/** Open (creating if needed) the database and migrate to the current schema. */
export function openDb(): Database.Database {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/** Migration-on-boot: schema.sql is idempotent (IF NOT EXISTS throughout). */
function migrate(db: Database.Database): void {
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
}

/**
 * --reset support: drop every user table and rebuild from schema.sql.
 * Dropping tables (rather than deleting the file) stays safe on Windows even
 * if another process holds the database open. Returns the dropped table names.
 */
export function resetDb(db: Database.Database): string[] {
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    for (const name of tables) {
      db.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
  })();
  db.pragma('foreign_keys = ON');
  migrate(db);
  return tables;
}

/** Make sure a source has a status row before its poller ever runs. */
export function ensureSourceStatus(db: Database.Database, source: string): void {
  db.prepare(
    `INSERT INTO source_status (source) VALUES (?) ON CONFLICT (source) DO NOTHING`,
  ).run(source);
}

export function recordSourceSuccess(db: Database.Database, source: string): void {
  db.prepare(
    `UPDATE source_status
     SET last_success = ?, last_error = NULL, consecutive_failures = 0
     WHERE source = ?`,
  ).run(new Date().toISOString(), source);
}

/** Records a failure and returns the new consecutive-failure count. */
export function recordSourceFailure(
  db: Database.Database,
  source: string,
  error: string,
): number {
  db.prepare(
    `UPDATE source_status
     SET last_error = ?, consecutive_failures = consecutive_failures + 1
     WHERE source = ?`,
  ).run(error, source);
  const row = db
    .prepare(`SELECT consecutive_failures FROM source_status WHERE source = ?`)
    .get(source) as Pick<SourceStatus, 'consecutive_failures'> | undefined;
  return row?.consecutive_failures ?? 1;
}

export function getSourceStatuses(db: Database.Database): SourceStatus[] {
  return db
    .prepare(
      `SELECT source, last_success, last_error, consecutive_failures
       FROM source_status ORDER BY source`,
    )
    .all() as SourceStatus[];
}
