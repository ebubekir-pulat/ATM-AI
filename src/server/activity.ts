import type Database from "better-sqlite3";
import { MAX_DEPOSIT_CENTS } from "./config";
import { formatAUD } from "./money";
import { localStamp } from "./time";
import { ActivityEntry } from "../shared/types";

export interface RecordEventInput {
  eventType: ActivityEntry["eventType"];
  userName: string;
  amountCents?: number | null;
  balanceAfterCents?: number | null;
  reason?: string | null;
}

export interface EntryFilter {
  eventType?: ActivityEntry["eventType"];
  userName?: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}

export interface ActivityRow {
  id: number;
  event_type: ActivityEntry["eventType"];
  user_name: string;
  amount_cents: number | null;
  balance_after_cents: number | null;
  reason: string | null;
  timestamp_ms: number;
  local_date: string;
  local_time: string;
}

export function recordEvent(db: Database.Database, input: RecordEventInput): ActivityEntry {
  const stamp = localStamp();

  const result = db
    .prepare(
      `INSERT INTO activity_log
         (event_type, user_name, amount_cents, balance_after_cents, reason, timestamp_ms, local_date, local_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.eventType,
      input.userName,
      input.amountCents ?? null,
      input.balanceAfterCents ?? null,
      input.reason ?? null,
      stamp.timestampMs,
      stamp.localDate,
      stamp.localTime,
    );

  const row = db
    .prepare(
      `SELECT id, event_type, user_name, amount_cents, balance_after_cents, reason, timestamp_ms, local_date, local_time
       FROM activity_log WHERE id = ?`,
    )
    .get(result.lastInsertRowid) as ActivityRow;

  return toPublicEntry(row);
}

export function listEntries(db: Database.Database, filter: EntryFilter = {}): ActivityEntry[] {
  const parts: string[] = [];
  const params: Array<string | number> = [];

  if (filter.eventType !== undefined) {
    parts.push("event_type = ?");
    params.push(filter.eventType);
  }
  if (filter.userName !== undefined) {
    parts.push("user_name = ?");
    params.push(filter.userName);
  }
  if (filter.fromMs !== undefined) {
    parts.push("timestamp_ms >= ?");
    params.push(filter.fromMs);
  }
  if (filter.toMs !== undefined) {
    parts.push("timestamp_ms <= ?");
    params.push(filter.toMs);
  }

  const where = parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "";
  const sql = `SELECT id, event_type, user_name, amount_cents, balance_after_cents, reason, timestamp_ms, local_date, local_time
               FROM activity_log${where} ORDER BY timestamp_ms ASC, id ASC LIMIT ?`;
  params.push(clampLimit(filter.limit));

  const rows = db.prepare(sql).all(...params) as ActivityRow[];
  return rows.map(toPublicEntry);
}

export function toPublicEntry(row: ActivityRow): ActivityEntry {
  const amount = row.amount_cents ?? 0;
  let message = "";

  switch (row.event_type) {
    case "login":
      message = `${row.user_name}: Logged in at ${row.local_time}`;
      break;
    case "logout":
      message = `${row.user_name}: Logged out at ${row.local_time}`;
      break;
    case "withdraw":
      message = `${row.user_name}: Withdrew ${formatAUD(amount)} at ${row.local_time}`;
      break;
    case "deposit":
      message = `${row.user_name}: Deposited ${formatAUD(amount)} at ${row.local_time}`;
      break;
    case "withdraw_failed":
      message = `${row.user_name}: Withdrawal of ${formatAUD(amount)} failed (${failureText(row.reason)}) at ${row.local_time}`;
      break;
    case "deposit_failed":
      message = `${row.user_name}: Deposit of ${formatAUD(amount)} failed (${failureText(row.reason)}) at ${row.local_time}`;
      break;
    case "transaction_cancelled":
      message = `${row.user_name}: Cancelled a withdrawal at ${row.local_time}`;
      break;
  }

  return {
    id: row.id,
    eventType: row.event_type,
    userName: row.user_name,
    amountCents: row.amount_cents,
    balanceAfterCents: row.balance_after_cents,
    reason: row.reason,
    timestampMs: row.timestamp_ms,
    localDate: row.local_date,
    localTime: row.local_time,
    message,
  };
}

function clampLimit(value: number | undefined): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 50;
  }
  return Math.min(200, Math.max(1, Math.trunc(number)));
}

function failureText(reason: string | null): string {
  if (reason === "insufficient_funds") {
    return "insufficient funds";
  }
  if (reason === "amount_too_large") {
    return `above the ${formatAUD(MAX_DEPOSIT_CENTS)} limit`;
  }
  return "invalid amount";
}
