# 07 — Transaction Locking (the core distributed-systems requirement)

**Depends on:** `05`, `06`.
**Delivers:** one central lock, held by at most one session at a time, enforced on
the server for deposit and withdraw, released on success, failure, cancel, sign-out,
disconnect and lease expiry. A second user is told who is transacting.
**Covers:** `specs.txt` §8 (all seven locking requirements), §6 items 1–3, §7
items 1–3, §13 B (cancellation), §13 C (lock timeout).

---

## 1. The lock in one paragraph

`lock.ts` holds **one** value in memory:

```ts
{ ownerSessionId: string; ownerName: string; acquiredAtMs: number; expiresAtMs: number } | null
```

A session acquires it with `POST /api/lock`. The owner must renew it every 10 s
while on the amount screen; the lease is 30 s. Every other session that asks is
refused with the owner's name. Deposit and withdraw **require** the lock, so a
client that skips the UI and posts straight to the transaction endpoint is refused
too — that is the whole point of the requirement. The lock is released by exactly
these events: a completed transaction, a failed transaction, an explicit cancel, a
sign-out, the last socket of the owning session disconnecting, or lease expiry.

In memory, not in SQLite, on purpose: a lock describes who is connected right now.
Persisting it would resurrect a dead lock after a restart, which is the stale-lock
failure the project is meant to prevent.

## 2. Files

Create: `src/server/lock.ts`, `src/server/http/routes/lock.ts`.
Modify: `src/server/http/routes/transactions.ts` (lock gate), `src/server/realtime.ts`
(disconnect hook, `broadcastLockState` already defined in slice 05),
`src/server/http/routes/session.ts` (release on sign-out), `src/server/index.ts`
(lease sweeper), `src/server/app.ts` (mount lock routes), `src/client/api.ts`
(lock calls), `src/client/state.ts` (lock actions), `src/client/main.ts`
(renewal timer, cancel path), `src/client/screens/home.ts` (locked banner),
`public/css/atm.css` (banner style).
Tests: `tests/server/lock.test.ts`, `tests/server/lock-routes.test.ts`,
`tests/server/transactions-lock.test.ts`.

## 3. `lock.ts`

```ts
export interface LockInfo {
  ownerSessionId: string; ownerName: string; acquiredAtMs: number; expiresAtMs: number;
}
export function acquire(sessionId: string, userName: string, nowMs?: number): LockInfo;
export function renew(sessionId: string, nowMs?: number): LockInfo;
export function release(sessionId: string, opts?: { reason?: "cancelled" | "disconnect" | "done" }): boolean;
export function releaseAllForSession(sessionId: string): boolean;
export function isLockOwner(sessionId: string | null): boolean;
export function getLock(): LockInfo | null;                       // lazily drops an expired lock
export function getLockState(sessionId: string | null): LockState; // adds isMine
export function sweepExpired(nowMs?: number): boolean;             // true when it just expired
export function resetLock(): void;                                 // tests only
```

Behaviour:

- `acquire` — if `getLock()` is `null`, take it (`expiresAtMs = now + LOCK_LEASE_MS`,
  `201`). If the caller already owns it, extend the lease and return it (`200`, so a
  double tap is idempotent). Otherwise throw `ApiError(423, "ACCOUNT_LOCKED", …)`
  with the message `Another transaction is in progress (USER2). Try again in a moment.`
- **The check and the set happen with no `await` between them.** This is the
  mutual-exclusion mechanism; it is one synchronous function in a single-threaded
  process, so no two requests can both find `null`. The rule for reviewers: never
  make `acquire` async, and never `await` inside it, not even for a log write.
- `renew` — owner only. Otherwise `ApiError(409, "LOCK_LOST", "Your transaction
  session expired. Please try again.")`. Renewing an expired lock is `LOCK_LOST`
  as well; expiry is checked first.
- `release` — no-op returning `false` if the caller is not the owner. Returns `true`
  when it removed a lock. It does not write log entries; the caller decides whether
  the release is worth recording (see §5).
- `getLock` — if `expiresAtMs <= now`, drop the lock and return `null`. Expiry is
  therefore enforced on every read, even if the sweeper never ran.
- `getLockState(sessionId)` → `{ locked, ownerName, isMine, expiresAtMs }`, with
  `isMine = ownerSessionId === sessionId` (`false` when `sessionId` is `null`).

`LOCK_LEASE_MS` is read from config (default 30 000) and is overridable per test.

## 4. Routes

| Method | Path | Body / query | Success | Failure |
|--------|------|--------------|---------|---------|
| POST | `/api/lock` | — | `201 { lock }` (or `200 { lock }` when already mine) | `423 ACCOUNT_LOCKED` |
| POST | `/api/lock/renew` | — | `200 { lock }` | `409 LOCK_LOST` |
| DELETE | `/api/lock` | `?cancelled=withdraw\|deposit` (optional) | `204` | — (idempotent) |
| GET | `/api/lock` | — | `200 { lock }` | — |

After every successful acquire, renew or release the handler calls
`broadcastLockState()` **after** the response body is prepared, so the other
browsers see the change within a frame. There is no database work in these routes.

`DELETE /api/lock?cancelled=withdraw` while holding the lock also writes one
`transaction_cancelled` entry with `reason = "cancelled"` and broadcasts it. Without
the query parameter (sign-out, page teardown) the release is silent — the log
records what people did to the account, not every button press.

## 5. Enforcement on transactions

In `transactions.ts`, before any work:

```ts
if (!isLockOwner(res.locals.session.id)) {
  throw new ApiError(409, "LOCK_NOT_HELD",
    "Start the transaction again from the home screen.");
}
```

Then, in a `finally` block after the transaction attempt: `release(sessionId, { reason: "done" })`
and `broadcastLockState()`. "Finally" covers success, validation failure and an
unexpected throw alike, which is requirement §8's "released if a transaction is
cancelled or fails". The failure entry is written by `account.ts` inside the
transaction (slice 06), so the log keeps the record of the attempt.

Release points, in one table — every row is a test:

| Trigger | Where | Log entry |
|---------|-------|-----------|
| Transaction succeeds | `transactions.ts` `finally` | `withdraw` / `deposit` (slice 06) |
| Validation fails | `transactions.ts` `finally` | `withdraw_failed` / `deposit_failed` |
| User presses BACK on the amount screen | `DELETE /api/lock?cancelled=…` | `transaction_cancelled` |
| User signs out while holding it | `DELETE /api/session` | `logout` |
| Owning session's last socket disconnects | `realtime.ts` `disconnect` | none |
| Lease expires with nobody renewing | `sweepExpired` / any `getLock` | none |
| Idle session swept (slice 04) | `index.ts` sweep | none |

## 6. Disconnect and timeout handling

- `attachRealtime` registers `socket.on("disconnect")`. It releases the lock if
  `socket.data.sessionId` owns it **and** no other connected socket belongs to that
  session. Socket.IO does not tell us how many sockets a session has, so
  `realtime.ts` keeps `Map<sessionId, Set<socketId>>` updated on connection and
  disconnection. A user with two tabs open therefore keeps the lock when one tab
  closes, and loses it when the second closes.
- `index.ts` starts `setInterval(() => { if (sweepExpired()) broadcastLockState(); }, 1000)`.
  1 s granularity is enough: the lease is 30 s, and a refusal message is never more
  than one second stale.
- Neither path writes a log entry. A lock that expired is not a transaction, and
  claiming "USER1 cancelled" when the browser crashed would be inventing an event.

## 7. Client

### Acquire

`Withdraw` / `Deposit` on the home screen:

1. `busy = true`, banner `Checking the account…`.
2. `POST /api/lock`.
3. `201`/`200` → `amountMode = …`, `amountDigits = ""`, screen `amount`,
   `busy = false`, start the renewal timer.
4. `423` → stay on `home`, `busy = false`, banner = the server's message
   (`Another transaction is in progress (USER2). Try again in a moment.`).
5. `NETWORK`/`401` → the standard paths from slices 04/05.

The buttons stay enabled while `state.lock.locked` is true, so a user always gets
the explanation instead of a dead control. A banner above the buttons reads
`USER2 is transacting…` while someone else holds the lock (from `lock:updated`),
and `You have the account for this transaction.` while it is ours.

On socket `connect`/reconnect, the handler from slice 05 also calls `getLock()` and
pushes it through `onLock`, so a browser that reconnects knows whether the account is
free before the user presses anything.

### Renewal

While `screen === "amount"`, a `setInterval(…, LOCK_RENEW_MS)` calls
`POST /api/lock/renew`:

- `200` → keep going silently. Reset the local countdown.
- `409 LOCK_LOST` → stop the timer, show the message screen
  (`Your transaction session expired. Nothing was changed.`), and on continue go
  home. The user must start again; the amount they typed is discarded.
- `NETWORK` → do nothing; the next tick tries again. A phone that loses Wi-Fi for
  a moment should not lose its place, and the lease still protects the account if
  it never comes back.

The timer is cleared whenever the screen is not `amount`, including sign-out,
error and success, so a renewal can never arrive for a session that has moved on.
It is also cleared in the same tick that ENTER sends the transaction — before the
request leaves the browser — because the transaction handler releases the lock and
a renewal sent alongside it would come back `409 LOCK_LOST` and show a false
"session expired" message over a successful transaction.

### Release

- BACK on the amount screen → `DELETE /api/lock?cancelled=<mode>` → `home`.
- Success or failure message → before going home, `DELETE /api/lock` without the
  parameter (the server has already released it in `finally`; this is an
  idempotent no-op that clears our timer).
- Sign out while on the amount screen is impossible: `Sign out` only exists on
  `home`. If the session dies anyway (401), the server released the lock with the
  session.

## 8. Tests

`tests/server/lock.test.ts` (pure, `resetLock()` in `beforeEach`)
1. acquire → `getLockState` shows `locked`, `isMine` for the owner, not for another.
2. second session acquire → throws `ApiError` 423 with the owner's name in the message.
3. same session acquire twice → same `acquiredAtMs`, later `expiresAtMs` (idempotent).
4. `renew` by a non-owner → 409 `LOCK_LOST`.
5. `release` by a non-owner → `false`, lock still held.
6. `release` by owner → `true`, `getLock() === null`.
7. acquire with `LOCK_LEASE_MS = 50`, wait 60 ms, another session acquires → success.
8. `getLock()` after expiry returns `null` even if `sweepExpired` never ran.
9. `sweepExpired` returns `true` exactly once for a given expiry.

`tests/server/lock-routes.test.ts` (Supertest, two logged-in agents A and B)
- A `POST /api/lock` → 201; B `POST /api/lock` → 423 with A's name in `error.message`.
- A renew loop: three `POST /api/lock/renew` → all 200, `expiresAtMs` increasing.
- A `DELETE /api/lock?cancelled=withdraw` → 204, one `transaction_cancelled` row,
  then B acquires → 201.
- A `DELETE /api/lock` twice → both 204, only the first has any effect.
- `GET /api/lock` as B while A holds it → `locked: true`, `isMine: false`.
- Sign-out while holding → `GET /api/lock` as B → free.
- **Race:** 20 fresh sessions fire `POST /api/lock` concurrently with `Promise.all`.
  Exactly one 201, nineteen 423, and `getLock()` names the winner. Repeat 5 times.

`tests/server/transactions-lock.test.ts`
- Deposit/withdraw with no lock → 409 `LOCK_NOT_HELD`, balance and log unchanged.
- A holds the lock; A withdraws successfully → 200 and the lock is free afterwards.
- A holds the lock; A attempts an over-balance withdrawal → 400 `INSUFFICIENT_FUNDS`
  and the lock is **free** afterwards (failure releases).
- A holds the lock; the owning socket disconnects → lock free (integration test with
  `socket.io-client`).
- 10 concurrent deposit requests from 5 sessions, each acquiring first and then
  posting, never corrupt the balance: final balance equals `100000 + 10000 * successes`,
  and `successes <= 10`.

## 9. Acceptance criteria

- [ ] Two browsers: A opens Withdraw, B presses Deposit and sees
      `Another transaction is in progress (A). Try again in a moment.`
- [ ] B's page still shows a live balance the whole time A is on the amount screen.
- [ ] A presses BACK: B's banner clears within a second, and A's cancel is in the log.
- [ ] `curl -X POST localhost:3000/api/transactions/deposit -H 'Content-Type: application/json' -d '{"amountCents":100}'`
      with a valid session cookie but no lock → 409 `LOCK_NOT_HELD`, and the balance
      is unchanged. (This is the "enforced server-side" proof.)
- [ ] A closes the tab on the amount screen: B can transact within a second or two,
      or after at most the lease.
- [ ] With `LOCK_LEASE_MS=2000`, A sits on the amount screen with renewals disabled:
      the lock frees itself at ~2 s and B can transact.
- [ ] `npm test` passes, including the 20-way acquire race.
