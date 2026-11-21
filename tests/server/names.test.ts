import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/server/db";
import { ensureName } from "../../src/server/names";

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("ensureName", () => {
  it("returns true first time, false second, leaves one row", () => {
    expect(ensureName(db, "SIMON")).toBe(true);
    expect(ensureName(db, "SIMON")).toBe(false);
    expect(ensureName(db, "ALEX")).toBe(true);

    const count = db.prepare("SELECT COUNT(*) AS n FROM user_names").get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("honours an explicit timestamp", () => {
    expect(ensureName(db, "SIMON", 12345)).toBe(true);
    const row = db.prepare("SELECT used_at_ms FROM user_names WHERE name = 'SIMON'").get() as { used_at_ms: number };
    expect(row.used_at_ms).toBe(12345);
  });
});

describe("ensureName on a file database", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join("/tmp/opencode", "atm-names-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists across close/reopen, used_at_ms unchanged", () => {
    const file = path.join(dir, "atm.db");

    const firstDb = openDatabase(file);
    expect(ensureName(firstDb, "SIMON")).toBe(true);
    const usedAt = (firstDb.prepare("SELECT used_at_ms FROM user_names WHERE name = 'SIMON'").get() as { used_at_ms: number }).used_at_ms;
    firstDb.close();

    const secondDb = openDatabase(file);
    expect(ensureName(secondDb, "SIMON")).toBe(false);
    const usedAt2 = (secondDb.prepare("SELECT used_at_ms FROM user_names WHERE name = 'SIMON'").get() as { used_at_ms: number }).used_at_ms;
    expect(usedAt2).toBe(usedAt);
    secondDb.close();
  });
});
