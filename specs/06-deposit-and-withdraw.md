# 06 — Deposit and Withdraw

**Depends on:** `02`, `04`, `05`.
**Delivers:** the two transaction endpoints with server-side validation, atomic
balance updates and log entries, and the amount-entry screens that drive them.
Single-user demo: one browser can deposit and withdraw and sees the new balance
everywhere.
**Covers:** `specs.txt` §6 (withdraw), §7 (deposit), §13 B (cancellation, as far
as the client is concerned), §13 D (atomic transactions).

Locking is **not** in this slice. Slice 07 makes both endpoints require the lock
and adds the acquire/release steps around the amount screen. The code shape here
is chosen so that slice 07 adds one call at the start and one at the end, and
nothing else.

---

## 1. Flow

```
home ── Withdraw / Deposit ──> amount screen
amount screen
   ├─ digit   -> append to amountDigits (max 7)
   ├─ CLEAR   -> empty the digits
   ├─ BACK    -> delete last digit; on an empty entry -> home (cancel)
   └─ ENTER   -> POST /api/transactions/withdraw|deposit { amountCents }
                    ├─ 200 -> message screen "SUCCESSFUL" + new balance -> ENTER -> home
                    └─ 4xx -> message screen with the server's message     -> ENTER -> home
```

## 2. Files

Create: `src/server/http/routes/transactions.ts`.
Modify: `src/client/screens/amount.ts` (placeholder becomes real),
`src/client/ui/money.ts` if slice 04 has not added it.
Modify: `src/server/account.ts` (`withdraw`, `deposit`), `src/server/app.ts`
(mount routes), `src/client/api.ts` (`withdraw`, `deposit`), `src/client/state.ts`
(reducer cases for the amount screen), `src/client/main.ts` (button wiring).
Tests: `tests/server/account.test.ts` (extend), `tests/server/transactions.test.ts`,
`tests/client/router.test.ts` (extend).

## 3. `account.ts`

```ts
export type TxResult =
  | { ok: true; account: Account; entry: ActivityEntry }
  | { ok: false; code: "INSUFFICIENT_FUNDS" | "AMOUNT_TOO_LARGE" | "INVALID_AMOUNT";
      message: string; entry: ActivityEntry };

export function withdraw(db: Database, userName: string, amountCents: number): TxResult;
export function deposit(db: Database, userName: string, amountCents: number): TxResult;
```

Both branches carry `entry` — the row the transaction wrote — so the route can
broadcast it without reading the log back.

Both run **one** `db.transaction(...)`, and inside it:

1. **Validate the argument.** Not an integer, `<= 0`, or `> 9_999_999_00` cents →
   `INVALID_AMOUNT`. (The route also validates the digits; this is the last line of
   defence and the path tests exercise.)
2. **For `withdraw`** read the balance. If `amountCents > balance` →
   `INSUFFICIENT_FUNDS`.
3. **For `deposit`** if `amountCents > MAX_DEPOSIT_CENTS` → `AMOUNT_TOO_LARGE`.
4. **On failure**, `recordEvent` a `withdraw_failed` / `deposit_failed` row with the
   attempted amount, `balance_after_cents = balance` (unchanged) and the `reason`,
   then return `{ ok: false, ... }`. Nothing else is written, so the transaction
   commits with only the failure row.
5. **On success**, `UPDATE account SET balance_cents = ?, updated_at_ms = ? WHERE id = 1`,
   `recordEvent` a `withdraw` / `deposit` row with the amount and the **new**
   balance, and return `{ ok: true, account }` read back from the table.

The read, the check and the update all happen inside the same synchronous
transaction, so no other request can read the balance between them. That is the
atomicity requirement — not a retry loop, not a mutex.

`balance_cents >= 0` is also enforced by the table's `CHECK`, so even a future bug
in the validation cannot store a negative balance.

Reasons recorded: `insufficient_funds`, `amount_too_large`, `invalid_amount`.

## 4. Routes

```ts
POST /api/transactions/withdraw   body { "amountCents": 50000 }
POST /api/transactions/deposit    body { "amountCents": 50000 }
```

Order of work in the handler:

1. `requireSession` (already applied to every route).
2. Parse `amountCents`: must be an integer, `> 0`, `<= 999_999_900`. Otherwise
   `400 INVALID_AMOUNT` with `Enter a whole dollar amount.`
3. Call `withdraw` / `deposit`.
4. `ok: false` → `recordEvent` already happened inside the transaction; respond
   with the mapped status: `INSUFFICIENT_FUNDS` → 400 with
   `That is more than the balance.`, `AMOUNT_TOO_LARGE` → 400 with
   `Deposits are limited to $10,000.00 per transaction.`
5. `ok: true` → respond `200 { account }`, then `broadcastAccount(account)` and
   `broadcastActivity(result.entry)`.

Because `TxResult` carries the entry, no route reads the log back to broadcast it.
The failure branch broadcasts too, so a second browser's evidence list (slice 08)
stays current without polling.

Broadcasts fire after the transaction commits, never inside it.

## 5. Client — amount screen

State: `amountMode: "withdraw" | "deposit" | null` and `amountDigits: string`.

Display:

```
WITHDRAWAL                 <- or DEPOSIT
Enter amount in dollars
Balance: $1,000.00

$500_                      <- echoed entry, caret at the end
```

- The client sends `amountCents: Number(amountDigits) * 100` — one multiplication of
  whole dollars, no float accumulation. It never sends a balance the server should
  trust; `digitsToCents` lives on the server.
- Keys: `0`–`9` append (ignored at 7 digits); `clear` empties; `back` deletes the
  last digit and, on an already empty entry, cancels to `home`; `enter` submits.
- ENTER with an empty entry shows `Enter an amount.` and does nothing else.
- ENTER with `0` shows `Amount must be more than zero.`
- ENTER first clears the lock renewal timer (slice 07), then posts. Clearing before
  the request is what keeps a renewal from racing the server-side release.
- While `busy`, the display reads `Processing…`, keys are ignored, and buttons are
  disabled. Double-tapping ENTER therefore cannot send two requests.
- Local sanity checks are for speed, not authority: withdraw above the displayed
  balance is still sent, and the server's `INSUFFICIENT_FUNDS` is what the user
  sees. The balance on screen may be a few hundred milliseconds old.
- Response handling: on success set `balanceCents` from the response, then
  `message` = `{ title: "SUCCESSFUL", body: "Withdrew $500.00\nNew balance $500.00" }`
  and screen `message`. On `HttpError` set the same screen with `title: "NOT COMPLETED"`
  and the server's `message` as the body.

`message` screen: ENTER (or clicking `Continue`) returns to `home` and refreshes the
balance with `getAccount()`. The message screen keeps the "back to home" action
available even after an error, so a user can never get stuck.

## 6. Client — home wiring

- `Withdraw` → `amountMode = "withdraw"`, `amountDigits = ""`, screen `amount`.
- `Deposit` → `amountMode = "deposit"`, same.
- Both stay enabled regardless of the balance: a zero balance simply produces the
  server's `INSUFFICIENT_FUNDS` message, which is more informative than a dead
  button.

## 7. Tests

`tests/server/account.test.ts` (extend, fresh `:memory:` db per test)

| Case | Expected |
|------|----------|
| withdraw `$500` from `$1,000` | `ok`, balance `50000`, one `withdraw` row, `balance_after_cents = 50000` |
| withdraw exactly the balance | `ok`, balance `0` |
| withdraw `$1,000.01` equivalent (`100001`) | `INSUFFICIENT_FUNDS`, balance unchanged, one `withdraw_failed` row with `reason = "insufficient_funds"` |
| withdraw `0` / `-1` / `1.5` | `INVALID_AMOUNT`, balance unchanged |
| withdraw from a `$0` balance | `INSUFFICIENT_FUNDS`, no `withdraw` row |
| deposit `$500` | `ok`, balance `150000`, one `deposit` row |
| deposit `1000000` (`$10,000.00`) | `ok` |
| deposit `1000001` | `AMOUNT_TOO_LARGE`, balance unchanged, `deposit_failed` row |
| two withdrawals of `$600` from `$1,000` in sequence | first `ok`, second `INSUFFICIENT_FUNDS`, final balance `40000` |

`tests/server/transactions.test.ts` (Supertest, logged-in agent)
- `POST` without a cookie → 401.
- Body `{ "amount": 500 }` (wrong field) → 400 `INVALID_AMOUNT`.
- `{ "amountCents": "50000" }` (string) → 400 `INVALID_AMOUNT`.
- Success → 200 with `{ account }`, and a follow-up `GET /api/account` agrees.
- Response headers are JSON; no HTML error page anywhere.
- The balance cannot go negative after a burst of 20 sequential `$300`
  withdrawals from `$1,000`: exactly 3 succeed and the balance is `10000`.

`tests/client/router.test.ts` (extend)
- digits build `amountDigits`, capped at 7.
- `back` on a non-empty entry removes a digit; on an empty entry returns to `home`.
- `enter` on an empty entry sets `banner` and stays on `amount`.

## 8. Acceptance criteria

- [ ] From `$1,000.00`, withdrawing `500` shows `Withdrew $500.00`, the new balance
      `$500.00`, and a second browser shows `$500.00` without a reload.
- [ ] Withdrawing `600` at a `$500` balance shows the server's message, the balance
      stays `$500.00`, and the log gains one `withdraw_failed` row.
- [ ] Depositing `10000` is accepted; `10001` is refused with the limit message.
- [ ] Entering an amount and pressing BACK until the entry is empty leaves the
      amount screen and returns home with the balance untouched.
- [ ] Double-tapping ENTER during `Processing…` produces exactly one request
      (checked in the server log / network tab) and exactly one log entry.
- [ ] `data/atm.db` shows one row per attempt: successes as `withdraw`/`deposit`,
      failures as `withdraw_failed`/`deposit_failed`, each with a local time.
- [ ] `npm test` passes.
