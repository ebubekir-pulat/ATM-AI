# Deposit and Withdraw — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-authoritative deposit and withdrawal endpoints and the amount-entry client flow, so every valid attempt atomically updates the shared balance (or leaves it untouched) and writes exactly one activity row; malformed input is rejected before anything is written.

**Architecture:** `account.ts` owns the money rules and runs validation, balance check, update and log write in one synchronous `db.transaction`. The route validates the wire shape, maps `TxResult` to HTTP, and broadcasts only after the transaction has returned. The client posts `amountCents`, renders the server's account and message, and never computes a balance itself.

**Tech Stack:** Node.js 20, Express 4, TypeScript (`strict`), better-sqlite3, Socket.IO 4, Vitest + Supertest, vanilla TypeScript client.

**Spec:** `specs/06-deposit-and-withdraw.md` (contracts: `specs/01-contracts.md` §4, §6, §9)

## Global Constraints

- All money is integer **cents**. The client sends `Number(amountDigits) * 100`; the server never parses dollars.
- Typed digits are whole dollars, 1–7 digits. The largest legal amount is `999_999_900` cents ($9,999,999.00).
- `MAX_DEPOSIT_CENTS` is `1_000_000` ($10,000.00). A deposit of exactly that is allowed; one cent more is `AMOUNT_TOO_LARGE`.
- The limits live once in `src/shared/constants.ts`: `MAX_AMOUNT_DIGITS = 7`, `MAX_DEPOSIT_CENTS = 1_000_000`, and `MAX_AMOUNT_CENTS = (10 ** MAX_AMOUNT_DIGITS - 1) * 100`. `src/server/config.ts` re-exports them; the client imports `MAX_AMOUNT_DIGITS` from that shared module. No duplicated numeric literals.
- Every attempt that passes wire validation writes exactly one log row: `withdraw`/`deposit` on success, `withdraw_failed`/`deposit_failed` on `INSUFFICIENT_FUNDS` / `AMOUNT_TOO_LARGE`.
- A malformed `amountCents` (wrong type, float, zero, negative, above `MAX_AMOUNT_CENTS`) is rejected at the route with `INVALID_AMOUNT` before any row is written. `INVALID_AMOUNT` never writes a log row.
- Success rows carry the **new** balance. Failure rows carry the **unchanged** balance and a reason.
- One `db.transaction(...)` per mutation. Broadcasts happen after it returns, never inside it.
- Express 4: route handlers are synchronous. A thrown `ApiError` must be a synchronous throw.
- The client displays server values; it never trusts or invents a balance.
- No `any`, no `@ts-ignore` in `src/`. Client imports use explicit `.js` extensions. Shared types use `import type`.
- **Locking is out of scope.** Add named no-op placeholders only; slice 07 fills them in.
- `activity.ts` already supports every event type in this slice. Do not change it.
- The only schema change is a `CHECK` on `activity_log.amount_cents`: it must be `NULL` or a positive integer. `0`, negatives and floats are rejected by the database.

## Review Focus

1. **Bad `amountCents` shapes** — string, float, zero, negative, `null`, or above `999_999_900` must return `400 INVALID_AMOUNT` as JSON, with no balance change and **no** log row. Pinned in Task 2.
2. **Overdraw under load** — twenty $300 withdrawals against $1,000 issued together via `Promise.all` must produce exactly three successes and a final balance of $100.00, never a negative balance. `better-sqlite3` is synchronous, so the requests are serialized by the event loop; this pins the check-then-update order, not cross-process concurrency. Pinned in Task 2.
3. **Failure log completeness** — insufficient funds and deposit-too-large each write one failed row with the attempted amount, unchanged balance and the right reason. `INVALID_AMOUNT` writes no row. No success row is ever written. Pinned in Task 1.
4. **Double-submit** — pressing ENTER twice while `busy` must send one request and write one row. Pinned by a reducer test in Task 4; `main.ts` short-circuits before dispatch.
5. **Broadcast ordering** — success broadcasts account then entry, failure broadcasts the entry (never for `INVALID_AMOUNT`), all before the response and after commit. Pinned by the route structure in Task 2 and the two-browser manual check.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/shared/constants.ts` | Single source for `MAX_AMOUNT_DIGITS`, `MAX_DEPOSIT_CENTS`, `MAX_AMOUNT_CENTS` |
| `src/server/config.ts` | Re-exports the shared limits alongside the env-derived constants |
| `src/server/db.ts` | Adds the positive-integer `CHECK` on `activity_log.amount_cents` |
| `src/server/account.ts` | `withdraw`, `deposit`, `TxResult`; the only place balance rules live |
| `src/server/http/routes/transactions.ts` | Parse `amountCents`, call the account function, map `TxResult` to HTTP, broadcast |
| `src/server/app.ts` | Mount the transactions router under `/api` |
| `src/client/api.ts` | `withdraw(amountCents)`, `deposit(amountCents)` wrappers |
| `src/client/state.ts` | Digit cap, amount ENTER validation, `message` / `dismissMessage` actions |
| `src/client/screens/amount.ts` | Busy/banner display |
| `src/client/screens/message.ts` | Multi-line body + Continue button |
| `src/client/main.ts` | Submit flow, message continue, lock placeholders |
| `tests/server/account.test.ts` | Extend with transaction tests |
| `tests/server/db.test.ts` | Extend with the `amount_cents` constraint test |
| `tests/server/transactions.test.ts` | New HTTP tests |
| `tests/client/router.test.ts` | Extend with amount and message reducer tests |
| `tests/client/screens.test.ts` | Extend with amount busy and message view tests |
| `tests/client/api.test.ts` | Extend with transaction wrapper tests |
| `README.md` | Mark slice 06 done |

---

## Task 1: Server — `withdraw` and `deposit`

**Files:**
- Create: `src/shared/constants.ts`
- Modify: `src/server/config.ts`
- Modify: `src/server/db.ts`
- Modify: `src/server/account.ts`
- Test: `tests/server/account.test.ts` (append to the existing file), `tests/server/config.test.ts`, `tests/server/db.test.ts`

**Interfaces:**
- Consumes: `getAccount(db)`, `recordEvent(db, input)`, `MAX_AMOUNT_CENTS` and `MAX_DEPOSIT_CENTS` from `./config` (re-exported from shared), `formatAUD(cents)` from `./money`.
- Produces:
  ```ts
  export type TxResult =
    | { ok: true; account: Account; entry: ActivityEntry }
    | { ok: false; code: "INSUFFICIENT_FUNDS" | "AMOUNT_TOO_LARGE";
        message: string; entry: ActivityEntry }
    | { ok: false; code: "INVALID_AMOUNT"; message: string; entry: null };
  export function withdraw(db: Database.Database, userName: string, amountCents: number): TxResult;
  export function deposit(db: Database.Database, userName: string, amountCents: number): TxResult;
  ```
  `MAX_AMOUNT_CENTS` is also available from `src/server/config.ts` for the route.

- [ ] **Step 1: Write the failing tests**

Add one assertion to the existing defaults test in `tests/server/config.test.ts`:

```ts
expect(config.MAX_AMOUNT_CENTS).toBe(999999900);
```

Add one test to `tests/server/db.test.ts`:

```ts
it("allows only NULL or a positive integer amount in the log", () => {
  const db = openTracked(":memory:");
  const insert = db.prepare(
    `INSERT INTO activity_log (event_type, user_name, amount_cents, timestamp_ms, local_date, local_time)
     VALUES ('withdraw', 'SIMON', ?, 1, '2026-11-15', '12:00:00')`,
  );
  expect(() => insert.run(0)).toThrow();
  expect(() => insert.run(-1)).toThrow();
  expect(() => insert.run(1.5)).toThrow();
  expect(() => insert.run(null)).not.toThrow();
  expect(() => insert.run(50000)).not.toThrow();
});
```

Append to `tests/server/account.test.ts`. Use the existing `:memory:` setup and add a row helper:

```ts
function rowsOfType(eventType: string) {
  return db.prepare(
    `SELECT amount_cents, balance_after_cents, reason
     FROM activity_log WHERE event_type = ? ORDER BY id`,
  ).all(eventType) as Array<{
    amount_cents: number;
    balance_after_cents: number;
    reason: string | null;
  }>;
}

it("withdraws and logs the new balance", () => {
  const result = withdraw(db, "SIMON", 50000);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.account.balanceCents).toBe(50000);
  expect(result.account.balanceFormatted).toBe("$500.00");
  expect(result.entry.eventType).toBe("withdraw");
  expect(rowsOfType("withdraw")).toEqual([
    { amount_cents: 50000, balance_after_cents: 50000, reason: null },
  ]);
});

it("withdraws exactly the balance", () => {
  const result = withdraw(db, "SIMON", 100000);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.account.balanceCents).toBe(0);
});

it("refuses an over-withdrawal and logs the unchanged balance", () => {
  const result = withdraw(db, "SIMON", 100001);
  expect(result).toMatchObject({
    ok: false,
    code: "INSUFFICIENT_FUNDS",
    message: "That is more than the balance.",
  });
  expect(getAccount(db).balanceCents).toBe(100000);
  expect(rowsOfType("withdraw")).toEqual([]);
  expect(rowsOfType("withdraw_failed")).toEqual([
    { amount_cents: 100001, balance_after_cents: 100000, reason: "insufficient_funds" },
  ]);
});

it.each([0, -1, 1.5, 999999901])("rejects invalid amount %s without logging", (amountCents) => {
  const result = withdraw(db, "SIMON", amountCents);
  expect(result).toMatchObject({ ok: false, code: "INVALID_AMOUNT", entry: null });
  expect(getAccount(db).balanceCents).toBe(100000);
  expect(rowsOfType("withdraw_failed")).toEqual([]);
  expect(rowsOfType("withdraw")).toEqual([]);
});

it("refuses a withdrawal from a zero balance", () => {
  db.prepare("UPDATE account SET balance_cents = 0 WHERE id = 1").run();
  const result = withdraw(db, "SIMON", 100);
  expect(result).toMatchObject({ ok: false, code: "INSUFFICIENT_FUNDS" });
  expect(rowsOfType("withdraw")).toEqual([]);
  expect(rowsOfType("withdraw_failed")).toHaveLength(1);
});

it("deposits and logs the new balance", () => {
  const result = deposit(db, "SIMON", 50000);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.account.balanceCents).toBe(150000);
  expect(rowsOfType("deposit")).toEqual([
    { amount_cents: 50000, balance_after_cents: 150000, reason: null },
  ]);
});

it("accepts exactly $10,000.00 and refuses one cent more", () => {
  const allowed = deposit(db, "SIMON", 1000000);
  expect(allowed.ok).toBe(true);
  if (!allowed.ok) return;
  expect(allowed.account.balanceCents).toBe(1100000);

  const refused = deposit(db, "SIMON", 1000001);
  expect(refused).toMatchObject({
    ok: false,
    code: "AMOUNT_TOO_LARGE",
    message: "Deposits are limited to $10,000.00 per transaction.",
  });
  expect(getAccount(db).balanceCents).toBe(1100000);
  expect(rowsOfType("deposit_failed")).toEqual([
    { amount_cents: 1000001, balance_after_cents: 1100000, reason: "amount_too_large" },
  ]);
});

it("applies two withdrawals in sequence", () => {
  expect(withdraw(db, "SIMON", 60000).ok).toBe(true);
  const second = withdraw(db, "SIMON", 60000);
  expect(second).toMatchObject({ ok: false, code: "INSUFFICIENT_FUNDS" });
  expect(getAccount(db).balanceCents).toBe(40000);
  expect(rowsOfType("withdraw")).toHaveLength(1);
  expect(rowsOfType("withdraw_failed")).toHaveLength(1);
});
```

Also update the imports at the top of the file to include `deposit`, `withdraw` and `getAccount`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/server/account.test.ts tests/server/config.test.ts tests/server/db.test.ts`
Expected: FAIL — `MAX_AMOUNT_CENTS` is not exported and `withdraw`/`deposit` are not exported.

- [ ] **Step 3: Add the shared constants, then implement `src/server/account.ts`**

Create `src/shared/constants.ts`:

```ts
export const MAX_AMOUNT_DIGITS = 7;
export const MAX_DEPOSIT_CENTS = 1_000_000;
export const MAX_AMOUNT_CENTS = (10 ** MAX_AMOUNT_DIGITS - 1) * 100;
```

In `src/server/db.ts`, add the constraint to the `activity_log` definition so a zero, negative or fractional amount can never be stored:

```sql
amount_cents INTEGER CHECK (amount_cents IS NULL OR (typeof(amount_cents) = 'integer' AND amount_cents > 0)),
```

**Local note — delete the old database:** the schema uses `CREATE TABLE IF NOT EXISTS`, so the `CHECK` applies only to fresh databases (tests and new installs). An existing `data/atm.db` keeps its old schema. Before running the app locally, delete it and its WAL sidecars so the constraint takes effect:

```bash
rm -f data/atm.db data/atm.db-wal data/atm.db-shm
```

No migration in this slice.

In `src/server/config.ts`, delete the local `MAX_DEPOSIT_CENTS` and `MAX_AMOUNT_DIGITS` declarations and re-export all three instead, so every existing `from "./config"` import keeps working:

```ts
export { MAX_AMOUNT_CENTS, MAX_AMOUNT_DIGITS, MAX_DEPOSIT_CENTS } from "../shared/constants";
```

In `src/server/account.ts`, import `MAX_AMOUNT_CENTS` and `MAX_DEPOSIT_CENTS` from `./config`. `formatAUD` already exists in `src/server/money.ts` and is already imported there; do not add a client formatter.

Add the `TxResult` type and implement both functions through one shared internal helper:

```ts
type TxKind = "withdraw" | "deposit";
type TxFailureCode = "INSUFFICIENT_FUNDS" | "AMOUNT_TOO_LARGE" | "INVALID_AMOUNT";

const FAILURE_MESSAGES: Record<TxFailureCode, string> = {
  INVALID_AMOUNT: "Enter a whole dollar amount.",
  INSUFFICIENT_FUNDS: "That is more than the balance.",
  AMOUNT_TOO_LARGE: `Deposits are limited to ${formatAUD(MAX_DEPOSIT_CENTS)} per transaction.`,
};
```

Behaviour of the helper, all inside one `db.transaction(() => { ... })()`:

1. Read the current balance with `getAccount(db)`.
2. If `!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS` → `INVALID_AMOUNT`. Write nothing and return `{ ok: false, code: "INVALID_AMOUNT", message: FAILURE_MESSAGES.INVALID_AMOUNT, entry: null }`.
3. If `kind === "withdraw" && amountCents > balance` → `INSUFFICIENT_FUNDS`.
4. If `kind === "deposit" && amountCents > MAX_DEPOSIT_CENTS` → `AMOUNT_TOO_LARGE`.
5. On `INSUFFICIENT_FUNDS` or `AMOUNT_TOO_LARGE`, write one row with `eventType: kind === "withdraw" ? "withdraw_failed" : "deposit_failed"`, the attempted `amountCents`, `balanceAfterCents: balance`, and `reason` (`insufficient_funds` or `amount_too_large`). Return `{ ok: false, code, message: FAILURE_MESSAGES[code], entry }`. Nothing else is written.
6. On success, `UPDATE account SET balance_cents = ?, updated_at_ms = ? WHERE id = 1`, write `withdraw`/`deposit` with the new balance, and return `{ ok: true, account: getAccount(db), entry }`.

`INVALID_AMOUNT` never reaches the route: `parseAmountCents` rejects the same shapes first. The branch stays as a backstop for direct callers, is covered by the unit tests, and intentionally writes no row.

Do not call `recordEvent` outside the transaction. Do not use a retry loop or mutex; better-sqlite3 is synchronous and the transaction is the atomicity mechanism. The `CHECK (balance_cents >= 0)` constraint is the backstop: never compute or write a negative balance.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/server/account.test.ts tests/server/config.test.ts tests/server/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/constants.ts src/server/config.ts src/server/db.ts src/server/account.ts \
  tests/server/account.test.ts tests/server/config.test.ts tests/server/db.test.ts
git commit -m "feat: add atomic deposit and withdraw account operations"
```

---

## Task 2: Server — Transaction Routes

**Files:**
- Create: `src/server/http/routes/transactions.ts`
- Modify: `src/server/app.ts`
- Test: `tests/server/transactions.test.ts` (new)

**Interfaces:**
- Consumes: `withdraw`, `deposit` from `src/server/account.ts`; `MAX_AMOUNT_CENTS` from `../../config`; `requireSession`; `ApiError`; `broadcastAccount`, `broadcastActivity`.
- Produces: `createTransactionsRouter(db: Database.Database): Router` mounted at `/api`.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/transactions.test.ts` with a fresh `:memory:` database, `clearSessions()` in `beforeEach`, and:

```ts
async function loginCookie(name = "SIMON"): Promise<string> {
  const res = await request(app).post("/api/session").send({ name }).expect(201);
  return res.headers["set-cookie"][0].split(";")[0];
}
```

Cover exactly these cases:

| Test | Expected |
|------|----------|
| `POST /api/transactions/withdraw` with no cookie | `401 NOT_AUTHENTICATED`, JSON |
| `{ "amount": 500 }` | `400 INVALID_AMOUNT`, message `"Enter a whole dollar amount."` |
| `{ "amountCents": "50000" }` | `400 INVALID_AMOUNT` |
| `{ "amountCents": 1.5 }` and `{ "amountCents": 0 }` | `400 INVALID_AMOUNT` |
| Any malformed shape above | `activity_log` stays empty and the balance is unchanged |
| Withdraw `50000` while logged in | `200 { account }`, `account.balanceCents === 50000`; `GET /api/account` agrees |
| Deposit `10000` | `200`, balance `110000` |
| Withdraw `100001` | `400 INSUFFICIENT_FUNDS`, message `"That is more than the balance."`; balance stays `100000`; one `withdraw_failed` row |
| Deposit `1000001` | `400 AMOUNT_TOO_LARGE`, message `"Deposits are limited to $10,000.00 per transaction."`; balance unchanged; one `deposit_failed` row |
| Twenty sequential `30000` withdrawals | exactly three `200`s and seventeen `400 INSUFFICIENT_FUNDS`; final `GET /api/account` balance `10000`; three `withdraw` rows and seventeen `withdraw_failed` rows |
| Twenty withdrawals issued together via `Promise.all` | same counts and final balance; never negative. `better-sqlite3` serializes them, so this pins check-then-update ordering, not cross-process concurrency |

Every error response in these tests must have `content-type` containing `application/json` and an `error.code` (no HTML).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/server/transactions.test.ts`
Expected: FAIL — `createTransactionsRouter` not found, or 404 for the routes.

- [ ] **Step 3: Implement `src/server/http/routes/transactions.ts`**

Import `MAX_AMOUNT_CENTS` from `../../config` (it is re-exported from the shared constants), then add:

```ts
function parseAmountCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_AMOUNT_CENTS) {
    throw new ApiError(400, "INVALID_AMOUNT", "Enter a whole dollar amount.");
  }
  return value;
}
```

A malformed value throws here, before the account layer runs, so it writes no log row — that is intended, not an omission.

`createTransactionsRouter(db)` registers two synchronous handlers, both behind `requireSession`:

- `POST /transactions/withdraw`
- `POST /transactions/deposit`

Each handler:

1. `const amountCents = parseAmountCents(req.body?.amountCents);`
2. Call `withdraw(db, res.locals.session.userName, amountCents)` or `deposit(...)`.
3. If `!result.ok`: if `result.entry !== null`, `broadcastActivity(result.entry);` then `throw new ApiError(400, result.code, result.message);` The entry was already committed by `account.ts`. `INVALID_AMOUNT` carries `entry: null` and broadcasts nothing.
4. If `ok`: `broadcastAccount(result.account); broadcastActivity(result.entry); res.json({ account: result.account });` in that order — broadcast before the response.

**Broadcast-before-response trade-off:** if a broadcast throws, Express returns `500` even though the transaction already committed, so the caller sees an error for money that did move. The alternative (respond, then broadcast) is worse: a throw after `res.json` is silent to peers and cannot be reported. Socket.IO `emit` is synchronous and does not throw in practice, so the window is theoretical.

Do not wrap the handler in `async`. Do not broadcast before the account call returns.

- [ ] **Step 4: Mount the router in `src/server/app.ts`**

Import `createTransactionsRouter` and add, next to the session router:

```ts
app.use("/api", createTransactionsRouter(deps.db));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/server/transactions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/http/routes/transactions.ts src/server/app.ts tests/server/transactions.test.ts
git commit -m "feat: add deposit and withdraw HTTP endpoints"
```

---

## Task 3: Client — Amount Entry State and View

**Files:**
- Modify: `src/client/state.ts`
- Modify: `src/client/screens/amount.ts`
- Test: `tests/client/router.test.ts`, `tests/client/screens.test.ts`

**Interfaces:**
- Consumes: existing `AppState`, `reduce`, `Key`, `formatCents`; `MAX_AMOUNT_DIGITS` from `../shared/constants.js`.
- Produces: reducer ENTER validation on the amount screen; `amountView` busy/banner display.

- [ ] **Step 1: Write the failing tests**

Append to `tests/client/router.test.ts`:

```ts
test("amount digits are capped at seven", () => {
  let state = amountState({ amountDigits: "" });
  for (const key of ["1", "2", "3", "4", "5", "6", "7", "8"] as const) {
    state = reduce(state, { type: "key", key });
  }
  expect(state.amountDigits).toBe("1234567");
});

test("ENTER on an empty amount shows a banner and stays", () => {
  let state = amountState({ amountDigits: "" });
  state = reduce(state, { type: "key", key: "enter" });
  expect(state.screen).toBe("amount");
  expect(state.banner).toBe("Enter an amount.");
});

test.each(["0", "000"])("ENTER on a zero amount (%s) shows a banner and stays", (digits) => {
  let state = amountState({ amountDigits: digits });
  state = reduce(state, { type: "key", key: "enter" });
  expect(state.screen).toBe("amount");
  expect(state.banner).toBe("Amount must be more than zero.");
});

test("ENTER on a valid amount leaves the screen for main.ts to submit", () => {
  let state = amountState({ amountDigits: "500" });
  state = reduce(state, { type: "key", key: "enter" });
  expect(state.screen).toBe("amount");
  expect(state.amountDigits).toBe("500");
  expect(state.banner).toBeNull();
});
```

Append to `tests/client/screens.test.ts`:

```ts
test("amountView shows Processing… while busy", () => {
  const state = createInitialState();
  state.screen = "amount";
  state.amountMode = "withdraw";
  state.busy = true;
  expect(amountView(state).banner).toBe("Processing…");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/client/router.test.ts tests/client/screens.test.ts`
Expected: FAIL — eight digits are accepted, ENTER does nothing, no busy banner.

- [ ] **Step 3: Implement in `src/client/state.ts`**

- Import `MAX_AMOUNT_DIGITS` from `../shared/constants.js`. Do not define a second literal; the server config re-exports the same value.
- In the `amount` branch of the `key` action:
  - Digits append only while `state.amountDigits.length < MAX_AMOUNT_DIGITS`; also clear `banner`.
  - `clear` empties digits and clears `banner`.
  - `back` deletes a digit and clears `banner`; when empty, returns to `home` with `amountMode: null`, `amountDigits: ""`, `banner: null`.
  - `enter`:
    - empty → `banner: "Enter an amount."`, stay on `amount`;
    - `Number(amountDigits) === 0` → `banner: "Amount must be more than zero."`, stay on `amount`;
    - otherwise return state unchanged except for the resolved multi-tap input. `main.ts` sends the request.
- The `amountMode` action clears `banner` and `busy` as well as setting the screen and clearing digits.

Do not add a local balance check that blocks a withdrawal. A withdrawal above the displayed balance is still sent; the server's `INSUFFICIENT_FUNDS` message is what the user sees. The client needs only `MAX_AMOUNT_DIGITS`: the digit cap makes the largest possible `amountCents` exactly the shared `MAX_AMOUNT_CENTS`, so there is no second limit to drift.

- [ ] **Step 4: Implement in `src/client/screens/amount.ts`**

Keep the existing title and lines. Add:

```ts
banner: state.busy ? "Processing…" : state.banner,
status: state.busy ? "info" : "error",
```

When idle and `banner` is `null`, nothing renders. Keys are already ignored while busy by the keypad callback in `main.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/client/router.test.ts tests/client/screens.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/state.ts src/client/screens/amount.ts tests/client/router.test.ts tests/client/screens.test.ts
git commit -m "feat: cap amount digits and validate amount entry"
```

---

## Task 4: Client — Submit, Message Screen and Wiring

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/state.ts`
- Modify: `src/client/screens/message.ts`
- Modify: `src/client/main.ts`
- Test: `tests/client/api.test.ts`, `tests/client/router.test.ts`, `tests/client/screens.test.ts`

**Interfaces:**
- Consumes: `request`, `HttpError`, `Account`; `amountView`, `messageView`, `setMessageCallbacks`; state actions.
- Produces:
  ```ts
  export async function withdraw(amountCents: number): Promise<Account>;
  export async function deposit(amountCents: number): Promise<Account>;
  export function setMessageCallbacks(callbacks: { onContinue: () => void }): void;
  ```
  New state actions: `{ type: "message"; title: string; body: string }` and `{ type: "dismissMessage" }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/client/api.test.ts` (add `withdraw` and `deposit` to its import from `../../src/client/api`):

```ts
it("withdraw posts amountCents and unwraps { account }", async () => {
  fetchMock().mockResolvedValue(jsonResponse(200, {
    account: { balanceCents: 50000, balanceFormatted: "$500.00", updatedAtMs: 1 },
  }));
  expect(await withdraw(50000)).toEqual({
    balanceCents: 50000, balanceFormatted: "$500.00", updatedAtMs: 1,
  });
  const [url, init] = fetchMock().mock.calls[0];
  expect(url).toBe("/api/transactions/withdraw");
  expect(init?.method).toBe("POST");
  expect(init?.body).toBe(JSON.stringify({ amountCents: 50000 }));
});

it("deposit uses the deposit endpoint", async () => {
  fetchMock().mockResolvedValue(jsonResponse(200, {
    account: { balanceCents: 110000, balanceFormatted: "$1,100.00", updatedAtMs: 1 },
  }));
  await deposit(10000);
  expect(fetchMock().mock.calls[0][0]).toBe("/api/transactions/deposit");
});

it("a refused transaction becomes an HttpError with the server message", async () => {
  fetchMock().mockResolvedValue(jsonResponse(400, {
    error: { code: "INSUFFICIENT_FUNDS", message: "That is more than the balance." },
  }));
  await expect(withdraw(100001)).rejects.toMatchObject({
    status: 400,
    code: "INSUFFICIENT_FUNDS",
    message: "That is more than the balance.",
  });
});
```

Append to `tests/client/router.test.ts`:

```ts
test("message action shows the message screen; dismissMessage returns home", () => {
  let state = homeState({ amountMode: "withdraw", amountDigits: "500" });
  state = reduce(state, {
    type: "message",
    title: "SUCCESSFUL",
    body: "Withdrew $500.00\nNew balance $500.00",
  });
  expect(state.screen).toBe("message");
  expect(state.message).toEqual({
    title: "SUCCESSFUL",
    body: "Withdrew $500.00\nNew balance $500.00",
  });

  state = reduce(state, { type: "dismissMessage" });
  expect(state.screen).toBe("home");
  expect(state.message).toBeNull();
  expect(state.amountMode).toBeNull();
  expect(state.amountDigits).toBe("");
});

test("keys are ignored while busy", () => {
  let state = amountState({ amountDigits: "500" });
  state = reduce(state, { type: "busy", isBusy: true });
  const next = reduce(state, { type: "key", key: "enter" });
  expect(next).toBe(state);
});
```

Append to `tests/client/screens.test.ts`:

```ts
test("messageView splits the body into lines and offers Continue", () => {
  const state = createInitialState();
  state.screen = "message";
  state.message = { title: "SUCCESSFUL", body: "Withdrew $500.00\nNew balance $500.00" };
  const vm = messageView(state);
  expect(vm.lines).toEqual(["Withdrew $500.00", "New balance $500.00"]);
  expect(vm.actions?.map((a) => a.label)).toEqual(["Continue"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/client/api.test.ts tests/client/router.test.ts tests/client/screens.test.ts`
Expected: FAIL — missing wrappers, actions and view behaviour.

- [ ] **Step 3: Implement `src/client/api.ts`**

Add both wrappers next to `getAccount`:

```ts
export async function withdraw(amountCents: number): Promise<Account> {
  const body = await request<{ account: Account }>("/api/transactions/withdraw", {
    method: "POST",
    body: JSON.stringify({ amountCents }),
  });
  return body.account;
}
```

`deposit` is identical with `/api/transactions/deposit`.

- [ ] **Step 4: Implement state actions in `src/client/state.ts`**

- At the top of the `key` action: `if (state.busy) return state;` so a second ENTER cannot reach `main.ts`, and the rule is unit-tested instead of manual.
- `message` → `{ ...state, screen: "message", message: { title, body }, banner: null }`.
- `dismissMessage` → `{ ...state, screen: "home", message: null, banner: null, amountMode: null, amountDigits: "" }`.

- [ ] **Step 5: Implement `src/client/screens/message.ts`**

Follow the `home.ts` callback pattern:

```ts
let onContinue: () => void = () => {};
export function setMessageCallbacks(callbacks: { onContinue: () => void }): void {
  onContinue = callbacks.onContinue;
}

export function messageView(state: AppState): ViewModel {
  return {
    title: state.message?.title || "",
    lines: state.message?.body ? state.message.body.split("\n") : [],
    actions: [{ label: "Continue", onClick: onContinue, disabled: state.busy }],
  };
}
```

- [ ] **Step 6: Wire `src/client/main.ts`**

Add the lock placeholders near the top of the file:

```ts
// Slice 07 replaces these no-ops with real lock calls.
function acquireLockPlaceholder(): void {}
function clearLockRenewalPlaceholder(): void {}
function releaseLockPlaceholder(): void {}
```

Home callbacks call `acquireLockPlaceholder()` before dispatching `amountMode`.

Add the submit function:

```ts
async function submitAmount() {
  const mode = state.amountMode;
  if (mode === null) return;

  const amountCents = Number(state.amountDigits) * 100;
  dispatch({ type: "busy", isBusy: true });
  try {
    const account = mode === "deposit" ? await deposit(amountCents) : await withdraw(amountCents);
    dispatch({ type: "balance", balanceCents: account.balanceCents });
    dispatch({
      type: "message",
      title: "SUCCESSFUL",
      body: `${mode === "deposit" ? "Deposited" : "Withdrew"} ${formatCents(amountCents)}\n` +
        `New balance ${account.balanceFormatted}`,
    });
  } catch (e) {
    dispatch({
      type: "message",
      title: "NOT COMPLETED",
      body: e instanceof HttpError ? e.message : "Cannot reach the ATM server.",
    });
  } finally {
    dispatch({ type: "busy", isBusy: false });
  }
}
```

Add the continue handler:

```ts
async function handleMessageContinue() {
  releaseLockPlaceholder();
  dispatch({ type: "dismissMessage" });
  await loadAccount();
}
```

A `401` from the transaction is shown on the message screen like every other `HttpError`. Continue calls `loadAccount()`, whose existing `handle401` path sends a dead session to login, so the user still cannot get stuck.

Lock lifecycle is complete: acquire on the home button, clear renewal on submit, release on back-to-empty and on Continue. Continue releases before `loadAccount()`, so the 401-to-login path releases too.

`main.ts` keeps its existing `if (state.busy) return;` in the keypad callback as the cheap first check; the reducer guard is the testable backstop.

Extend `handleKey` before the final `dispatch`:

```ts
if (state.screen === "amount" && key === "enter") {
  dispatch({ type: "key", key });
  if (state.amountDigits.length > 0 && Number(state.amountDigits) > 0) {
    clearLockRenewalPlaceholder();
    void submitAmount();
  }
  return;
}

if (state.screen === "amount" && key === "back" && state.amountDigits.length === 0) {
  releaseLockPlaceholder();
}

if (state.screen === "message" && key === "enter") {
  void handleMessageContinue();
  return;
}
```

Wire `setMessageCallbacks({ onContinue: () => { void handleMessageContinue(); } })` next to `setHomeCallbacks`, and import `withdraw`, `deposit` from `api.js`, `setMessageCallbacks` from `message.js`, and `formatCents` from `ui/money.js`.

Leave the home buttons' enabled rule unchanged: they are disabled only while `busy`, never because the balance is zero. A zero balance must produce the server's `INSUFFICIENT_FUNDS` message.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/client/api.test.ts tests/client/router.test.ts tests/client/screens.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/client/api.ts src/client/state.ts src/client/screens/message.ts src/client/main.ts \
  tests/client/api.test.ts tests/client/router.test.ts tests/client/screens.test.ts
git commit -m "feat: submit deposits and withdrawals from the amount screen"
```

---

## Task 5: Build, Full Suite, README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Build both targets**

Run: `npm run build`
Expected: no TypeScript errors; server in `dist/`, client in `public/js/`.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: all tests pass, no open handles.

- [ ] **Step 3: Update `README.md`**

Change "Slices 01–05" to "Slices 01–06" and add one bullet:

```md
- **06** — deposit and withdraw: amount entry, atomic balance updates, and
  success/failure entries in the activity log.
```

Keep the "Later slices (transactions, locks, AI assistant, …)" line accurate: remove
"transactions" from it and leave locks/AI as not implemented.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: mark slice 06 complete"
```

---

## Acceptance Criteria Checklist

- [ ] From $1,000.00, withdrawing $500 shows "Withdrew $500.00" and "$500.00", and a second browser shows $500.00 without a reload.
- [ ] Withdrawing $600 at a $500 balance shows "That is more than the balance.", balance stays $500.00, and the log gains one `withdraw_failed` row.
- [ ] Depositing $10,000.00 is accepted; $10,000.01 is refused with the limit message.
- [ ] Pressing BACK until the entry is empty leaves the amount screen with the balance untouched.
- [ ] Double-tapping ENTER during "Processing…" produces one request and one log entry.
- [ ] `data/atm.db` has one row per valid attempt: `withdraw`/`deposit` for successes, `withdraw_failed`/`deposit_failed` for insufficient funds or over-limit deposits, each with a local timestamp. A malformed `amountCents` writes no row.
- [ ] `npm test` passes.

---

## Manual Verification

1. **Balance propagates:** first delete any database created before this slice with `rm -f data/atm.db data/atm.db-wal data/atm.db-shm`, then start the server (`npm start`), open two browsers, log in with two names. In browser A withdraw $500. Both browsers show $500.00 within a second; the activity list (slice 08) gains one `withdraw` row.
2. **Insufficient funds:** in A press Withdraw, type `600`, ENTER. The message screen shows "NOT COMPLETED" and "That is more than the balance."; continue; balance is still $500.00. `sqlite3 data/atm.db "SELECT event_type, amount_cents, balance_after_cents, reason FROM activity_log ORDER BY id DESC LIMIT 1;"` shows `withdraw_failed|60000|50000|insufficient_funds`.
3. **Deposit limit:** deposit `10000` → success, balance rises by $10,000.00. Deposit `10001` → "NOT COMPLETED" with the limit message, balance unchanged, one `deposit_failed` row.
4. **Cancel:** press Withdraw, type `123`, press BACK four times. The fourth BACK (empty entry) returns to home; balance and log are unchanged.
5. **Double submit:** on a slow connection, tap ENTER twice quickly. The display shows "Processing…", the keypad is inert, and only one transaction row is added.
6. **Raw API:** with a session cookie, `curl -X POST localhost:3000/api/transactions/withdraw -H 'Content-Type: application/json' -d '{"amountCents":"50000"}'` returns `400` JSON with `INVALID_AMOUNT` and writes no row; `-d '{"amountCents":50000}'` returns `200` and `{ "account": { ... } }`.
