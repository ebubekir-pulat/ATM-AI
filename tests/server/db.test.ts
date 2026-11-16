import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/server/db";

let open: Database.Database[] = [];

function openTracked(dbPath: string): Database.Database {
  const db = openDatabase(dbPath);
  open.push(db);
  return db;
}

function tempPath(...segments: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atm-test-"));
  return path.join(dir, ...segments);
}

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

describe("openDatabase", () => {
  it("seeds exactly one account row with $1,000.00", () => {
    const db = openTracked(":memory:");
    expect(db.prepare("SELECT id, balance_cents FROM account").all()).toEqual([
      { id: 1, balance_cents: 100000 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM user_names").get()).toEqual({ n: 0 });
  });

  it("creates the three tables and the timestamp index", () => {
    const db = openTracked(":memory:");
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
      .all() as { name: string }[];
    expect(names.map((row) => row.name)).toEqual(
      expect.arrayContaining(["account", "activity_log", "activity_log_timestamp_idx", "user_names"]),
    );
  });

  it("records the schema version", () => {
    const db = openTracked(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(1);
  });

  it("creates missing parent directories", () => {
    const file = tempPath("nested", "data", "atm.db");
    openTracked(file);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("uses WAL for file databases", () => {
    const db = openTracked(tempPath("atm.db"));
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("keeps a changed balance across close and reopen without re-seeding", () => {
    const file = tempPath("atm.db");
    const first = openDatabase(file);
    first.prepare("UPDATE account SET balance_cents = ?, updated_at_ms = ? WHERE id = 1").run(12345, 1);
    first.close();

    const second = openDatabase(file);
    expect(second.prepare("SELECT balance_cents FROM account WHERE id = 1").get()).toEqual({
      balance_cents: 12345,
    });
    expect(second.prepare("SELECT COUNT(*) AS n FROM account").get()).toEqual({ n: 1 });
    second.close();
  });

  it("opens an existing database without throwing", () => {
    const file = tempPath("atm.db");
    openTracked(file);
    expect(() => openTracked(file)).not.toThrow();
  });
});
