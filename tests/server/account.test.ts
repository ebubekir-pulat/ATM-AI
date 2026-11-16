import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/server/db";
import { getAccount } from "../../src/server/account";
import { ApiError } from "../../src/server/http/errors";

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("getAccount", () => {
  it("returns the seeded balance formatted as AUD", () => {
    const account = getAccount(db);
    expect(account.balanceCents).toBe(100000);
    expect(account.balanceFormatted).toBe("$1,000.00");
    expect(typeof account.updatedAtMs).toBe("number");
  });

  it("reflects a stored balance change", () => {
    db.prepare("UPDATE account SET balance_cents = ?, updated_at_ms = ? WHERE id = 1").run(1, 42);
    expect(getAccount(db)).toEqual({
      balanceCents: 1,
      balanceFormatted: "$0.01",
      updatedAtMs: 42,
    });
  });

  it("throws INTERNAL when the account row is missing", () => {
    db.exec("DELETE FROM account");
    expect(() => getAccount(db)).toThrow(ApiError);
    try {
      getAccount(db);
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.status).toBe(500);
      expect(apiError.code).toBe("INTERNAL");
      expect(apiError.message).toBe("Account is missing.");
    }
  });
});
