import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { INITIAL_BALANCE_CENTS } from "./config";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS account (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type          TEXT    NOT NULL CHECK (event_type IN
                        ('login','logout','withdraw','deposit',
                         'withdraw_failed','deposit_failed','transaction_cancelled')),
  user_name           TEXT    NOT NULL,
  amount_cents        INTEGER,
  balance_after_cents INTEGER,
  reason              TEXT,
  timestamp_ms        INTEGER NOT NULL,
  local_date          TEXT    NOT NULL,
  local_time          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS activity_log_timestamp_idx ON activity_log (timestamp_ms);

CREATE TABLE IF NOT EXISTS user_names (
  name       TEXT PRIMARY KEY,
  used_at_ms INTEGER NOT NULL
);
`;

export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  if (dbPath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");

  db.exec(SCHEMA_SQL);
  db.pragma("user_version = 1");

  const seed = db.transaction(() => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM account").get() as { n: number };
    if (row.n === 0) {
      db.prepare("INSERT INTO account (id, balance_cents, updated_at_ms) VALUES (1, ?, ?)").run(
        INITIAL_BALANCE_CENTS,
        Date.now(),
      );
    }
  });
  seed();

  return db;
}
