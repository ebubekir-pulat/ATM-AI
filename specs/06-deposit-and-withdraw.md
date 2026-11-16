# 06 — Deposit and Withdraw

**Depends on:** `02`, `04`, `05`.
**Delivers:** both transaction endpoints with server-side validation, atomic balance
updates and log entries, plus the amount screens that drive them. Single-user demo: one
browser deposits and withdraws and the new balance appears everywhere.
**Covers:** `specs.txt` §6, §7, §13 B (cancellation, client half), §13 D (atomicity).

Locking is **not** in this slice. Slice 07 makes both endpoints require the lock and
adds acquire/release around the amount screen; the code shape here leaves that as one
call at the start and one at the end.

---

## 1. Flow

```
home ── Withdraw / Deposit ──> amount screen
amount screen
   ├─ digit   -> append to amountDigits (max 7)
   ├─ CLEAR   -> empty the digits
   ├─ BACK    -> delete last digit; on an empty entry -> home (cancel)
   └─ ENTER   -> POST /api/transactions/withdraw|deposit { amountCents }
                    ├─ 200 -> "SUCCESSFUL" message + new balance -> ENTER -> home
                    └─ 4xx -> message screen with the server's message -> ENTER -> home
```

Files: create `src/server/http/routes/transactions.ts`; modify `account.ts`,
`app.ts`, `api.ts`, `state.ts`, `main.ts`, `screens/amount.ts`, and `ui/money.ts` if
slice 04 has not added it. Tests: `tests/server/{account,transactions}.test.ts`,
`tests/client/router.test.ts`.

## 2. `account.ts`

```ts
export type TxResult =
  | { ok: true; account: Account; entry: ActivityEntry }
  | { ok: false; code: "INSUFFICIENT_FUNDS" | "AMOUNT_TOO_LARGE" | "INVALID_AMOUNT";
      message: string; entry: ActivityEntry };

export function withdraw(db: Database, userName: string, amountCents: number): TxResult;
export function deposit(db: Database, userName: string, amountCents: number): TxResult;
```

Both branches carry `entry`, so the route broadcasts it without re-reading the log.

Both run **one** `db.transaction(...)` containing:

1. **Validate the argument.** Not an integer, `<= 0`, or `> 999_999_900` →
   `INVALID_AMOUNT`. (The route validates too; this is the last line of defence.)
2. **Withdraw:** read the balance; if `amountCents > balance` → `INSUFFICIENT_FUNDS`.
3. **Deposit:** if `amountCents > MAX_DEPOSIT_CENTS` → `AMOUNT_TOO_LARGE`.
4. **On failure:** `recordEvent` a `withdraw_failed` / `deposit_failed` row with the
   attempted amount, the unchanged `balance_after_cents` and the `reason`, then return
   `{ ok: false, … }`. Nothing else is written.
5. **On success:** `UPDATE account SET balance_cents = ?, updated_at_ms = ? WHERE id =
   1`, `recordEvent` a `withdraw` / `deposit` row with the amount and the **new**
   balance, and return `{ ok: true, account }` read back from the table.

The read, the check and the update happen inside one synchronous transaction, so no
other request can interleave. That is the atomicity mechanism — not a retry loop, not a
mutex. The table's `CHECK (balance_cents >= 0)` backs it up.

Reasons recorded: `insufficient_funds`, `amount_too_large`, `invalid_amount`.

## 3. Routes

```
POST /api/transactions/withdraw   { "amountCents": 50000 }
POST /api/transactions/deposit    { "amountCents": 50000 }
```

Order of work:

1. `requireSession` (already applied to every route).
2. Parse `amountCents`: integer, `> 0`, `<= 999_999_900`, else `400 INVALID_AMOUNT`
   with `Enter a whole dollar amount.`
3. Call `withdraw` / `deposit`.
4. `ok: false` → the entry is already written; respond `400` with
   `That is more than the balance.` (`INSUFFICIENT_FUNDS`) or
   `Deposits are limited to $10,000.00 per transaction.` (`AMOUNT_TOO_LARGE`).
5. `ok: true` → `200 { account }`, then `broadcastAccount(account)` and
   `broadcastActivity(result.entry)`.

The failure branch broadcasts too, so a second browser's evidence list (slice 08) stays
current without polling. Broadcasts fire after the commit, never inside it.

## 4. Client — amount screen

State: `amountMode: "withdraw" | "deposit" | null`, `amountDigits: string`.

```
WITHDRAWAL                 <- or DEPOSIT
Enter amount in dollars
Balance: $1,000.00

$500_                      <- echoed entry, caret at the end
```

- The client sends `amountCents: Number(amountDigits) * 100` — one multiplication of
  whole dollars, no float accumulation. It never sends a balance the server should
  trust; `digitsToCents` lives on the server.
- Keys: `0`–`9` append (ignored at 7 digits); `clear` empties; `back` deletes the last
  digit and, on an empty entry, cancels to `home`; `enter` submits.
- ENTER on an empty entry shows `Enter an amount.` and does nothing else. ENTER on `0`
  shows `Amount must be more than zero.`
- ENTER first clears the lock renewal timer (slice 07), then posts — clearing before the
  request keeps a renewal from racing the server-side release.
- While `busy` the display reads `Processing…`, keys are ignored and buttons disabled,
  so double-tapping ENTER cannot send two requests.
- Local checks are for speed, not authority: a withdrawal above the displayed balance is
  still sent and the server's `INSUFFICIENT_FUNDS` is what the user sees.
- Success: set `balanceCents` from the response, then `message = { title: "SUCCESSFUL",
  body: "Withdrew $500.00\nNew balance $500.00" }`, screen `message`. `HttpError`: same
  screen with `title: "NOT COMPLETED"` and the server's `message` as the body.

The `message` screen returns to `home` on ENTER (or clicking `Continue`) and refreshes
with `getAccount()`. It keeps that action after an error, so a user can never get stuck.

## 5. Home wiring

- `Withdraw` → `amountMode = "withdraw"`, `amountDigits = ""`, screen `amount`.
- `Deposit` → `amountMode = "deposit"`, same.
- Both stay enabled regardless of balance: a zero balance produces the server's
  `INSUFFICIENT_FUNDS` message, which is more informative than a dead button.

## 6. Tests

`tests/server/account.test.ts` (fresh `:memory:` db per test)

| Case | Expected |
|------|----------|
| withdraw `$500` from `$1,000` | ok, balance `50000`, one `withdraw` row with `balance_after_cents = 50000` |
| withdraw exactly the balance | ok, balance `0` |
| withdraw `100001` | `INSUFFICIENT_FUNDS`, balance unchanged, one `withdraw_failed` row with `reason = "insufficient_funds"` |
| withdraw `0` / `-1` / `1.5` | `INVALID_AMOUNT`, balance unchanged |
| withdraw from `$0` | `INSUFFICIENT_FUNDS`, no `withdraw` row |
| deposit `$500` | ok, balance `150000`, one `deposit` row |
| deposit `1000000` | ok |
| deposit `1000001` | `AMOUNT_TOO_LARGE`, balance unchanged, `deposit_failed` row |
| two `$600` withdrawals in sequence | first ok, second `INSUFFICIENT_FUNDS`, final balance `40000` |

`tests/server/transactions.test.ts` (Supertest, logged-in agent)
- no cookie → 401; `{ "amount": 500 }` → 400 `INVALID_AMOUNT`; `{ "amountCents":
  "50000" }` → 400.
- success → 200 with `{ account }`, and `GET /api/account` agrees.
- responses are JSON; no HTML error page anywhere.
- 20 sequential `$300` withdrawals from `$1,000`: exactly 3 succeed, balance `10000`.

`tests/client/router.test.ts` (extended)
- digits build `amountDigits`, capped at 7; `back` removes a digit, and on an empty entry
  returns to `home`; `enter` on an empty entry sets `banner` and stays on `amount`.

## 7. Acceptance criteria

- [ ] From `$1,000.00`, withdrawing `500` shows `Withdrew $500.00` and `$500.00`, and a
      second browser shows `$500.00` without a reload.
- [ ] Withdrawing `600` at a `$500` balance shows the server's message, the balance
      stays `$500.00`, and the log gains one `withdraw_failed` row.
- [ ] Depositing `10000` is accepted; `10001` is refused with the limit message.
- [ ] BACK until the entry is empty leaves the amount screen, balance untouched.
- [ ] Double-tapping ENTER during `Processing…` produces one request and one log entry.
- [ ] `data/atm.db` has one row per attempt: `withdraw`/`deposit` for successes,
      `withdraw_failed`/`deposit_failed` for failures, each with a local time.
- [ ] `npm test` passes.
