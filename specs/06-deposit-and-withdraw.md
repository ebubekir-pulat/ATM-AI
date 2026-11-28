# 06 — Deposit and Withdraw

**Depends on:** Slices 02, 04, 05.  
**Delivers:** Both transaction endpoints (deposit/withdraw) with server-side validation, atomic balance updates, and log entries. Also delivers the amount-entry screens. In the single-user demo, one browser deposits or withdraws and the new balance appears everywhere instantly.  
**Covers:** specs.txt sections 6, 7, 13B (cancellation, client half), 13D (atomicity).

Locking is **not** in this slice. Slice 07 adds locking around the amount screen; this slice leaves placeholder calls for acquiring and releasing the lock.

---

## 1. Flow

```
home → press Withdraw or Deposit → amount screen
amount screen
   ├─ digit key   → add digit to amount (max 7 digits)
   ├─ CLEAR       → clear all digits
   ├─ BACK        → delete last digit; if already empty → go back to home (cancel)
   └─ ENTER       → POST /api/transactions/withdraw|deposit { amountCents }
                        ├─ 200 OK → show "SUCCESSFUL" message with new balance → ENTER → home
                        └─ 4xx error → show message screen with server's error → ENTER → home
```

**Files to create/modify:**  
Create `src/server/http/routes/transactions.ts`; modify `account.ts`, `app.ts`, `api.ts`, `state.ts`, `main.ts`, `screens/amount.ts`, and `ui/money.ts` (if slice 04 hasn't added it).  
**Tests:** `tests/server/{account,transactions}.test.ts`, `tests/client/router.test.ts`.

---

## 2. `account.ts`

```ts
export type TxResult =
  | { ok: true; account: Account; entry: ActivityEntry }
  | { ok: false; code: "INSUFFICIENT_FUNDS" | "AMOUNT_TOO_LARGE" | "INVALID_AMOUNT";
      message: string; entry: ActivityEntry };

export function withdraw(db: Database, userName: string, amountCents: number): TxResult;
export function deposit(db: Database, userName: string, amountCents: number): TxResult;
```

Both success and failure return an `entry` so the route can broadcast it without re-reading the log.

Both functions run **one** `db.transaction(...)` containing:

1. **Validate the amount.** Not an integer, ≤ 0, or > 999,999,900 cents → `INVALID_AMOUNT`. (The route also validates; this is the final safety net.)
2. **Withdraw:** read the balance; if `amountCents > balance` → `INSUFFICIENT_FUNDS`.
3. **Deposit:** if `amountCents > MAX_DEPOSIT_CENTS` (1,000,000 cents = $10,000) → `AMOUNT_TOO_LARGE`.
4. **On failure:** write a `withdraw_failed` or `deposit_failed` row with the attempted amount, the unchanged balance, and the reason. Return `{ ok: false, ... }`. Nothing else is written.
5. **On success:** update the account balance and `updated_at_ms`, write a `withdraw` or `deposit` row with the amount and **new** balance, return `{ ok: true, account }` read back from the table.

The read, check, and update happen inside one synchronous transaction — no other request can interleave. This is the atomicity mechanism (not a retry loop or mutex). The table's `CHECK (balance_cents >= 0)` constraint backs it up.

**Failure reasons recorded:** `insufficient_funds`, `amount_too_large`, `invalid_amount`.

---

## 3. Routes

```
POST /api/transactions/withdraw   { "amountCents": 50000 }
POST /api/transactions/deposit    { "amountCents": 50000 }
```

**Order of work:**

1. `requireSession` (already on every route).
2. Parse `amountCents`: must be an integer, > 0, ≤ 999,999,900. Otherwise → 400 `INVALID_AMOUNT` with message `"Enter a whole dollar amount."`
3. Call `withdraw` / `deposit`.
4. If `ok: false` → the log entry is already written. Respond 400 with:
   - `"That is more than the balance."` for `INSUFFICIENT_FUNDS`
   - `"Deposits are limited to $10,000.00 per transaction."` for `AMOUNT_TOO_LARGE`
5. If `ok: true` → 200 with `{ account }`, then `broadcastAccount(account)` and `broadcastActivity(result.entry)`.

The failure branch also broadcasts, so a second browser's activity list (slice 08) stays current without polling. Broadcasts fire **after** the commit, never inside it.

---

## 4. Client — Amount Screen

**State:** `amountMode: "withdraw" | "deposit" | null`, `amountDigits: string`.

```
WITHDRAWAL                 (or DEPOSIT)
Enter amount in dollars
Balance: $1,000.00

$500_                      (typed digits shown here, cursor at end)
```

- The client sends `amountCents: Number(amountDigits) * 100` — one multiplication of whole dollars, no floating-point math. The client never sends a balance the server should trust; `digitsToCents` lives on the server.
- Keys: `0`–`9` append (ignored after 7 digits); `CLEAR` empties; `BACK` deletes last digit, and on an empty entry cancels to `home`; `ENTER` submits.
- `ENTER` on empty entry → shows `"Enter an amount."` and does nothing else. `ENTER` on `0` → shows `"Amount must be more than zero."`
- `ENTER` first clears the lock renewal timer (slice 07), then posts — clearing before the request prevents a renewal from racing the server-side release.
- While `busy` the display reads `"Processing…"`, keys are ignored and buttons disabled, so double-tapping ENTER cannot send two requests.
- Local checks are for speed only, not authority: a withdrawal above the displayed balance is still sent, and the server's `INSUFFICIENT_FUNDS` is what the user sees.
- **Success:** set `balanceCents` from response, then show message screen with `title: "SUCCESSFUL"`, `body: "Withdrew $500.00\nNew balance $500.00"`.
- **Error (HttpError):** same message screen with `title: "NOT COMPLETED"` and the server's message as the body.

The message screen returns to `home` on `ENTER` (or clicking `Continue`) and refreshes with `getAccount()`. It keeps this behavior after an error, so a user can never get stuck.

---

## 5. Home Wiring

- `Withdraw` button → `amountMode = "withdraw"`, `amountDigits = ""`, go to `amount` screen.
- `Deposit` button → `amountMode = "deposit"`, same.
- Both buttons stay enabled regardless of balance: a zero balance produces the server's `INSUFFICIENT_FUNDS` message
upon clicking the `Withdraw` button, which is more informative than a disabled button.

---

## 6. Tests

### `tests/server/account.test.ts` (fresh `:memory:` db per test)

| Case | Expected |
|------|----------|
| withdraw $500 from $1,000 | ok, balance 50000, one `withdraw` row with `balance_after_cents = 50000` |
| withdraw exactly the balance | ok, balance 0 |
| withdraw $1,000.01 | `INSUFFICIENT_FUNDS`, balance unchanged, one `withdraw_failed` row with `reason = "insufficient_funds"` |
| withdraw 0 / -1 / 1.5 | `INVALID_AMOUNT`, balance unchanged |
| withdraw from $0 | `INSUFFICIENT_FUNDS`, no `withdraw` row |
| deposit $500 | ok, balance 150000, one `deposit` row |
| deposit $10,000.00 | ok |
| deposit $10,000.01 | `AMOUNT_TOO_LARGE`, balance unchanged, `deposit_failed` row |
| two $600 withdrawals in sequence | first ok, second `INSUFFICIENT_FUNDS`, final balance 40000 |

### `tests/server/transactions.test.ts` (Supertest, logged-in agent)
- No cookie → 401
- `{ "amount": 500 }` → 400 `INVALID_AMOUNT`
- `{ "amountCents": "50000" }` (string) → 400
- Success → 200 with `{ account }`, and `GET /api/account` agrees
- Responses are JSON; no HTML error pages anywhere
- 20 sequential $300 withdrawals from $1,000: exactly 3 succeed, final balance $100.00

### `tests/client/router.test.ts` (extended)
- Digits build `amountDigits`, capped at 7
- `BACK` removes a digit; on empty entry returns to `home`
- `ENTER` on empty entry sets `banner` and stays on `amount`

---

## 7. Acceptance Criteria

- [ ] From $1,000.00, withdrawing $500 shows "Withdrew $500.00" and "$500.00", and a second browser shows $500.00 without a reload.
- [ ] Withdrawing $600 at a $500 balance shows the server's message, balance stays $500.00, and the log gains one `withdraw_failed` row.
- [ ] Depositing $10000 is accepted; $10001 is refused with the limit message.
- [ ] Pressing BACK until the entry is empty leaves the amount screen, balance untouched.
- [ ] Double-tapping ENTER during "Processing…" produces one request and one log entry.
- [ ] `data/atm.db` has one row per attempt: `withdraw`/`deposit` for successes, `withdraw_failed`/`deposit_failed` for failures, each with a local timestamp.
- [ ] `npm test` passes.