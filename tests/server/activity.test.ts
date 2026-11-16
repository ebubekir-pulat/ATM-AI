import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { listEntries, recordEvent, toPublicEntry, type ActivityRow } from "../../src/server/activity";
import { openDatabase } from "../../src/server/db";

function row(overrides: Partial<ActivityRow>): ActivityRow {
  return {
    id: 1,
    event_type: "login",
    user_name: "User1",
    amount_cents: null,
    balance_after_cents: null,
    reason: null,
    timestamp_ms: 1763200000000,
    local_date: "2026-11-15",
    local_time: "12:40:00",
    ...overrides,
  };
}

describe("toPublicEntry", () => {
  it.each([
    [{ event_type: "login", local_time: "12:30:45" }, "User1: Logged in at 12:30:45"],
    [{ event_type: "logout", local_time: "12:41:00" }, "User1: Logged out at 12:41:00"],
    [{ event_type: "withdraw", amount_cents: 500000 }, "User1: Withdrew $5,000.00 at 12:40:00"],
    [{ event_type: "deposit", amount_cents: 50000 }, "User1: Deposited $500.00 at 12:40:00"],
    [
      { event_type: "withdraw_failed", amount_cents: 500000, reason: "insufficient_funds" },
      "User1: Withdrawal of $5,000.00 failed (insufficient funds) at 12:40:00",
    ],
    [
      { event_type: "deposit_failed", amount_cents: 1200000, reason: "amount_too_large" },
      "User1: Deposit of $12,000.00 failed (above the $10,000.00 limit) at 12:40:00",
    ],
    [
      { event_type: "withdraw_failed", amount_cents: 0, reason: "invalid_amount" },
      "User1: Withdrawal of $0.00 failed (invalid amount) at 12:40:00",
    ],
    [{ event_type: "transaction_cancelled" }, "User1: Cancelled a withdrawal at 12:40:00"],
  ])("renders %j", (overrides, expected) => {
    expect(toPublicEntry(row(overrides as Partial<ActivityRow>)).message).toBe(expected);
  });

  it("maps every column onto the public entry", () => {
    const entry = toPublicEntry(
      row({ id: 7, event_type: "deposit", amount_cents: 50000, balance_after_cents: 105000, reason: "cancelled" }),
    );
    expect(entry).toMatchObject({
      id: 7,
      eventType: "deposit",
      userName: "User1",
      amountCents: 50000,
      balanceAfterCents: 105000,
      reason: "cancelled",
      timestampMs: 1763200000000,
      localDate: "2026-11-15",
      localTime: "12:40:00",
    });
  });
});

let db: Database.Database;
beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
});

function insertRaw(
  eventType: string,
  userName: string,
  timestampMs: number,
  localDate = "2026-11-15",
  localTime = "12:00:00",
): void {
  db.prepare(
    `INSERT INTO activity_log
       (event_type, user_name, amount_cents, balance_after_cents, reason, timestamp_ms, local_date, local_time)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(eventType, userName, timestampMs, localDate, localTime);
}

describe("recordEvent", () => {
  it("stamps the row itself and returns the public entry", () => {
    const before = Date.now();
    const entry = recordEvent(db, {
      eventType: "withdraw",
      userName: "USER1",
      amountCents: 500000,
      balanceAfterCents: 50000,
    });

    expect(entry.timestampMs).toBeGreaterThanOrEqual(before);
    expect(entry.message).toBe(`USER1: Withdrew $5,000.00 at ${entry.localTime}`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_log").get()).toEqual({ n: 1 });
  });

  it("stores null amount and balance for a login", () => {
    const entry = recordEvent(db, { eventType: "login", userName: "USER1" });
    expect(entry.amountCents).toBeNull();
    expect(entry.balanceAfterCents).toBeNull();
  });
});

describe("listEntries", () => {
  it("returns zero rows for an empty log", () => {
    expect(listEntries(db)).toEqual([]);
  });

  it("orders by timestamp, then id", () => {
    insertRaw("login", "SECOND", 2000);
    insertRaw("login", "FIRST", 1000);
    insertRaw("login", "THIRD", 3000);
    expect(listEntries(db).map((entry) => entry.userName)).toEqual(["FIRST", "SECOND", "THIRD"]);
  });

  it("keeps insertion order for rows in the same millisecond", () => {
    insertRaw("login", "A", 1000);
    insertRaw("login", "B", 1000);
    expect(listEntries(db).map((entry) => entry.userName)).toEqual(["A", "B"]);
  });

  it("filters by event type and user name", () => {
    insertRaw("login", "A", 1000);
    insertRaw("deposit", "A", 2000);
    insertRaw("deposit", "B", 3000);
    expect(listEntries(db, { eventType: "deposit" }).map((e) => e.userName)).toEqual(["A", "B"]);
    expect(listEntries(db, { userName: "A" }).map((e) => e.eventType)).toEqual(["login", "deposit"]);
    expect(listEntries(db, { eventType: "deposit", userName: "B" })).toHaveLength(1);
  });

  it("filters by an inclusive time window", () => {
    insertRaw("login", "A", 1000);
    insertRaw("login", "B", 2000);
    insertRaw("login", "C", 3000);
    expect(listEntries(db, { fromMs: 2000, toMs: 3000 }).map((e) => e.userName)).toEqual(["B", "C"]);
  });

  it("returns no rows for an unknown event type", () => {
    insertRaw("login", "A", 1000);
    expect(listEntries(db, { eventType: "transfer" as never })).toEqual([]);
  });

  it("treats a hostile user name as data, not SQL", () => {
    insertRaw("login", "A", 1000);
    expect(listEntries(db, { userName: "' OR 1=1 --" })).toEqual([]);
  });

  it("defaults to 50, clamps to 1..200 and survives a non-numeric limit", () => {
    for (let i = 1; i <= 205; i += 1) insertRaw("login", `U${i}`, i);
    expect(listEntries(db)).toHaveLength(50);
    expect(listEntries(db, { limit: 0 })).toHaveLength(1);
    expect(listEntries(db, { limit: 500 })).toHaveLength(200);
    expect(listEntries(db, { limit: Number.NaN })).toHaveLength(50);
  });
});
