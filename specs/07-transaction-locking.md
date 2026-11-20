# 07 — Transaction Locking (the core distributed-systems requirement)

**Depends on:** `05`, `06`.
**Delivers:** one central lock, held by at most one session at a time, enforced on the
server for deposit and withdraw, released on success, failure, cancel, sign-out,
disconnect and lease expiry. A second user is told who is transacting.
**Covers:** `specs.txt` §8 (all seven requirements), §6 items 1–3, §7 items 1–3, §13 B,
§13 C.

---

## 1. The lock in one paragraph

`lock.ts` holds **one** in-memory value:

```ts
{ ownerSessionId: string; ownerName: string; acquiredAtMs: number; expiresAtMs: number } | null
```

A session acquires it with `POST /api/lock`. The owner renews every 10 s while on the
amount screen; the lease is 30 s. Every other session is refused with the owner's name.
Deposit and withdraw **require** the lock, so a client that skips the UI and posts
straight to the transaction endpoint is refused too — that is the point of the
requirement. Released by exactly: completed transaction, failed transaction, explicit
cancel, sign-out, last socket of the owning session disconnecting, lease expiry.

In memory, not SQLite, on purpose: a lock describes who is connected right now.
Persisting it would resurrect a dead lock after a restart.

Files: create `src/server/lock.ts`, `src/server/http/routes/lock.ts`; modify
`routes/transactions.ts` (gate), `realtime.ts` (disconnect hook), `routes/session.ts`
(release on sign-out), `index.ts` (sweeper), `app.ts`, and on the client `api.ts`,
`state.ts`, `main.ts` (renewal timer, cancel path), `screens/home.ts` (locked banner),
`atm.css`. Tests: `tests/server/{lock,lock-routes,transactions-lock}.test.ts`.

## 2. `lock.ts`

Signatures in `01` §9. Behaviour:

- `acquire` — if `getLock()` is `null`, take it with
  `expiresAtMs = now + LOCK_LEASE_MS` (route answers `201`). If the caller already owns
  it, extend the lease and return it (`200`, so a double tap is idempotent). Otherwise
  `ApiError(423, "ACCOUNT_LOCKED", "Another transaction is in progress (BLAKE). Try
  again in a moment.")`.
- **The check and the set have no `await` between them.** That is the
  mutual-exclusion mechanism: one synchronous function in a single-threaded process, so
  no two requests can both find `null`. Rule for reviewers: never make `acquire` async,
  never `await` inside it, not even for a log write.
- `renew` — owner only, else `ApiError(409, "LOCK_LOST", "Your transaction session
  expired. Please try again.")`. Expiry is checked first, so renewing an expired lock is
  `LOCK_LOST` too.
- `release` — no-op returning `false` when the caller is not the owner; `true` when it
  removed the lock. It writes no log entry; the caller decides.
- `getLock` — if `expiresAtMs <= now`, drop the lock and return `null`, so expiry is
  enforced on every read even if the sweeper never ran.
- `getLockState(sessionId)` → `{ locked, ownerName, isMine, expiresAtMs }` with
  `isMine = ownerSessionId === sessionId` (`false` for `null`).

`LOCK_LEASE_MS` comes from config and is overridable per test.

## 3. Routes

| Method | Path | Body / query | Success | Failure |
|--------|------|--------------|---------|---------|
| POST | `/api/lock` | — | `201 { lock }` (or `200` when already mine) | `423 ACCOUNT_LOCKED` |
| POST | `/api/lock/renew` | — | `200 { lock }` | `409 LOCK_LOST` |
| DELETE | `/api/lock` | `?cancelled=withdraw\|deposit` | `204` (idempotent) | — |
| GET | `/api/lock` | — | `200 { lock }` | — |

After every successful acquire, renew or release the handler calls
`broadcastLockState()`. These routes do no database work.

`DELETE /api/lock?cancelled=withdraw` while holding the lock also writes one
`transaction_cancelled` entry with `reason = "cancelled"` and broadcasts it. Without the
query parameter (sign-out, page teardown) the release is silent: the log records what
people did to the account, not every button press.

## 4. Enforcement on transactions

In `transactions.ts`, before any work:

```ts
if (!isLockOwner(res.locals.session.id)) {
  throw new ApiError(409, "LOCK_NOT_HELD",
    "Start the transaction again from the home screen.");
}
```

Then in a `finally` block: `release(sessionId, { reason: "done" })` and
`broadcastLockState()`. `finally` covers success, validation failure and an unexpected
throw alike — `specs.txt` §8's "released if a transaction is cancelled or fails". The
failure entry itself is written by `account.ts` inside the transaction.

| Trigger | Where | Log entry |
|---------|-------|-----------|
| Transaction succeeds | `transactions.ts` `finally` | `withdraw` / `deposit` |
| Validation fails | `transactions.ts` `finally` | `withdraw_failed` / `deposit_failed` |
| BACK on the amount screen | `DELETE /api/lock?cancelled=…` | `transaction_cancelled` |
| Sign-out while holding it | `DELETE /api/session` | `logout` |
| Owning session's last socket disconnects | `realtime.ts` `disconnect` | none |
| Lease expires unrenewed | `sweepExpired` / any `getLock` | none |
| Session swept past its grace | `index.ts` sweep | none |

Every row is a test (§7).

## 5. Disconnect and timeout

- `attachRealtime` registers `socket.on("disconnect")`. It releases the lock when
  `socket.data.sessionId` owns it **and** the session's socket count dropped to zero. A
  user with two tabs therefore keeps the lock when one closes and loses it when the
  second closes.
- `index.ts` runs `setInterval(() => { if (sweepExpired()) broadcastLockState(); },
  1000)`. With a 30 s lease, 1 s granularity means a refusal is never more than a second
  stale.
- Neither path writes a log entry: an expired lock is not a transaction, and claiming
  "SIMON cancelled" when the browser crashed would be inventing an event.

## 6. Client

**Acquire.** `Withdraw` / `Deposit` on `home`:

1. `busy = true`, banner `Checking the account…`.
2. `POST /api/lock`.
3. `201`/`200` → set `amountMode`, clear `amountDigits`, screen `amount`, `busy = false`,
   start the renewal timer.
4. `423` → stay on `home`, `busy = false`, banner = the server's message.
5. `NETWORK`/`401` → the standard paths from slices 04/05.

Buttons stay enabled while `state.lock.locked` is true, so a user always gets the
explanation. A banner above the buttons reads `BLAKE is transacting…` while someone else
holds the lock and `You have the account for this transaction.` while it is ours. On
socket connect/reconnect the slice 05 handler also calls `getLock()`, so a reconnecting
browser knows the state before the user presses anything.

**Renewal.** While `screen === "amount"`, a `setInterval(…, LOCK_RENEW_MS)` posts to
`/api/lock/renew`:

- `200` → keep going, reset the local countdown.
- `409 LOCK_LOST` → stop the timer, show `Your transaction session expired. Nothing was
  changed.`, and go home on continue. The typed amount is discarded.
- `NETWORK` → do nothing; the next tick retries. A phone that loses Wi-Fi for a moment
  should not lose its place, and the lease protects the account if it never returns.

The timer is cleared whenever the screen is not `amount` (sign-out, error, success), and
in the same tick that ENTER sends the transaction — before the request leaves the
browser. Otherwise a renewal racing the server-side release would return `409 LOCK_LOST`
and show a false "session expired" over a successful transaction.

**Release.** BACK on `amount` → `DELETE /api/lock?cancelled=<mode>` → `home`. After a
message screen, `DELETE /api/lock` without the parameter before going home — the server
already released it in `finally`, so this is an idempotent no-op that clears the timer.
`Sign out` exists only on `home`; if a session dies anyway (401), the server released the
lock with it.

## 7. Tests

`tests/server/lock.test.ts` (pure, `resetLock()` in `beforeEach`)

1. acquire → `locked`, `isMine` for the owner, not for another session.
2. second session acquire → throws `ApiError` 423 naming the owner.
3. same session twice → same `acquiredAtMs`, later `expiresAtMs`.
4. `renew` by a non-owner → `LOCK_LOST`.
5. `release` by a non-owner → `false`, lock still held.
6. `release` by the owner → `true`, `getLock() === null`.
7. `LOCK_LEASE_MS = 50`, wait 60 ms, another session acquires → success.
8. `getLock()` after expiry returns `null` even if `sweepExpired` never ran.
9. `sweepExpired` returns `true` exactly once per expiry.

`tests/server/lock-routes.test.ts` (Supertest, agents A and B)
- A `POST` → 201; B `POST` → 423 with A's name in `error.message`.
- A renews three times → all 200, `expiresAtMs` increasing.
- A `DELETE ?cancelled=withdraw` → 204, one `transaction_cancelled` row, then B → 201.
- A `DELETE` twice → both 204, only the first has an effect.
- B `GET /api/lock` while A holds it → `locked: true`, `isMine: false`.
- A signs out while holding → B sees it free.
- **Race:** 20 fresh sessions `POST /api/lock` with `Promise.all` → one 201, nineteen
  423, `getLock()` names the winner. Repeat 5 times (twenty distinct names, since two
  sessions cannot hold one name).

`tests/server/transactions-lock.test.ts`
- deposit/withdraw with no lock → 409 `LOCK_NOT_HELD`, balance and log unchanged.
- A holds the lock and withdraws → 200, lock free afterwards.
- A holds the lock and over-withdraws → 400 `INSUFFICIENT_FUNDS`, lock **free**
  afterwards.
- A holds the lock and its socket disconnects → lock free (`socket.io-client`).
- 10 concurrent deposits from 5 sessions, each acquiring first: final balance is
  `100000 + 10000 * successes` and `successes <= 10`.

## 8. Acceptance criteria

- [ ] Two browsers: A opens Withdraw, B presses Deposit and reads `Another transaction is
      in progress (A). Try again in a moment.`
- [ ] B still sees a live balance throughout.
- [ ] A presses BACK: B's banner clears within a second, and A's cancel is in the log.
- [ ] A direct `POST /api/transactions/deposit` with a valid session cookie but no lock →
      409 `LOCK_NOT_HELD`, balance unchanged (the server-side enforcement proof).
- [ ] A closes the tab on the amount screen: B can transact within a second or two, or at
      most after the lease.
- [ ] With `LOCK_LEASE_MS=2000` and renewals disabled, the lock frees itself at ~2 s.
- [ ] `npm test` passes, including the 20-way acquire race.
