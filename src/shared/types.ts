export type Session = { userName: string };
export type Account = { balanceCents: number; balanceFormatted: string; updatedAtMs: number };
export type ActivityEntry = {
  id: number;
  eventType: "login" | "logout" | "withdraw" | "deposit"
    | "withdraw_failed" | "deposit_failed" | "transaction_cancelled";
  userName: string;
  amountCents: number | null;
  balanceAfterCents: number | null;
  reason: string | null;
  timestampMs: number;
  localDate: string;
  localTime: string;
  message: string;
};
export type LockState = {
  locked: boolean;
  ownerName: string | null;
  isMine: boolean;
  expiresAtMs: number | null;
};
