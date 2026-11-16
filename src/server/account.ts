import type Database from "better-sqlite3";
import { Account } from "../shared/types";
import { formatAUD } from "./money";
import { ApiError } from "./http/errors";

export function getAccount(db: Database.Database): Account {
  const row = db
    .prepare("SELECT balance_cents, updated_at_ms FROM account WHERE id = 1")
    .get() as { balance_cents: number; updated_at_ms: number } | undefined;

  if (row === undefined) {
    throw new ApiError(500, "INTERNAL", "Account is missing.");
  }

  return {
    balanceCents: row.balance_cents,
    balanceFormatted: formatAUD(row.balance_cents),
    updatedAtMs: row.updated_at_ms,
  };
}
