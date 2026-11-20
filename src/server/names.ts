import type Database from "better-sqlite3";

export function ensureName(db: Database.Database, name: string, nowMs?: number): boolean {
  const timestamp = nowMs ?? Date.now();

  const result = db
    .prepare(`INSERT INTO user_names (name, used_at_ms) VALUES (?, ?) ON CONFLICT DO NOTHING`)
    .run(name, timestamp);

  return result.changes > 0;
}
