# 04 — Login, Sessions and Homepage

**Depends on:** `02`, `03`.
**Delivers:** login with multi-tap names, server-side sessions in a cookie, the
homepage with the live balance and its three buttons, sign out, and `login` / `logout`
log entries.
**Covers:** `specs.txt` §3, §5, §11 including "handle unexpected disconnects".

---

## 1. Flow

```
page load ── GET /api/session ── 200 ──> home
                              └─ 401 ──> login
login     ── typing (3+ letters) ── GET /api/session/availability ──> "in use" (only while live)
          └─ ENTER ── POST /api/session { name }
                ├─ 201 ──> new name   ┐ home + login entry
                ├─ 200 ──> known name ┘
                ├─ 409 ──> banner, name kept, still on login
                └─ 400 ──> banner, name kept, still on login
home      ├─ Withdraw / Deposit -> slices 06/07
          └─ Sign out -> DELETE /api/session ── 204 ──> login + logout entry
```

Files: create `src/client/api.ts`, `src/server/sessions.ts`, `src/server/names.ts`,
`src/server/http/requireSession.ts`, `src/server/http/routes/session.ts`; modify
`app.ts`, `main.ts`, `state.ts`, `screens/{login,home}.ts`. Tests:
`tests/server/{sessions,names,session-routes}.test.ts`, `tests/client/router.test.ts`.

## 2. `sessions.ts` and `names.ts`

Signatures in `01` §9. Sessions are in memory; names are rows in `user_names`.

`sessions.ts`:

- `id` is `crypto.randomUUID()` and is the only thing in the cookie. No user data.
- `createSession` starts with `sockets: 0` and `absentSinceMs: now`, so a session that
  never connects is swept instead of living forever. The next request or socket
  connection clears the clock.
- `readSessionId` parses the `Cookie` header for `atm_sid`, tolerating spaces, other
  cookies and a missing header; it returns `null` rather than throwing.
- `getSession` returns `null` when gone, otherwise refreshes `lastSeenMs` and clears
  `absentSinceMs`: a request proves the person is still there.
- **Liveness rule, used everywhere:** a session is live unless `sockets === 0` and
  `now - absentSinceMs > SESSION_GRACE_MS`. `setSessionSockets(id, 0)` starts the
  countdown, `setSessionSockets(id, n > 0)` clears it. `index.ts` calls
  `sweepSessions` every 5 s.
- `setSessionSockets` on an unknown or destroyed id is a no-op — a socket disconnecting
  after sign-out must not throw.
- **A name is held exactly as long as its session is live.** `findSessionByName` applies
  the liveness rule, so it returns the holder of `USER1` and `null` once that session is
  gone. Comparison is exact (`USER1` ≠ `USER10`).
- Sweeping and expiry write **no `logout` entry**: the person did not sign out, and
  claiming they did would be an event the log cannot support. Slice 07 releases any
  lock the swept session held.
- Sessions do not survive a restart; the balance, the log and the names do.

`names.ts`:

- `ensureName(db, name, nowMs?)` — `INSERT INTO user_names (name, used_at_ms) ON CONFLICT
  DO NOTHING`, returning `true` when it inserted a row. It is the identity registry: one
  row per name, created at the first login and reused on every later login.
- Names are **never deleted**. `SIMON` today and `SIMON` next week therefore produce log
  rows with the same `user_name`, which is the whole point: the name is how the log names
  a person.

So there are two different rules, and both matter:

| Rule | Enforced by |
|------|-------------|
| A name is one row, reused by whoever types it | primary key on `user_names` |
| No two sessions hold the same name at once | `findSessionByName` in `POST /api/session` |

Signing out (or a swept session) frees the name for reuse, not ownership: the row stays,
so the next `SIMON` is the same `SIMON` in the log. There are no passwords, so the server
cannot tell whether that is the same human — the name is a label, and the log says exactly
what was typed.

## 3. Routes

### `POST /api/session`

```ts
// request            { "name": "USER1" }
// 201 (new name) / 200 (known name)  { "session": { "userName": "USER1" } }
// Set-Cookie: atm_sid=<uuid>; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400
```

Validation and uniqueness, in this order:

| Condition | Status / code | `message` |
|-----------|---------------|-----------|
| body not an object, or `name` not a string | 400 `INVALID_NAME` | `Enter your name.` |
| not `^[A-Z]{3,20}$` after trimming | 400 `INVALID_NAME` | `Name must be 3 to 20 letters (A-Z).` |
| the caller's own live session already has this name | `200` | — (no new session, no new entry) |
| the caller's live session has a **different** name | 400 `INVALID_NAME` | `Sign out before signing in with another name.` |
| another live session holds this name | 409 `NAME_TAKEN` | `That name is already in use. Try another name.` |
| otherwise | `201` for a new name, `200` for a known one | — |

Trimming is `String.prototype.trim()` only. Uppercasing is the caller's job (the keypad
produces A–Z), so a lowercase name is rejected rather than silently changed.

The liveness check (`findSessionByName`) and the session creation are **synchronous,
with no `await` between them**, so two people pressing ENTER on the same name at the same
instant cannot both get a session.

Side effects, in one `db.transaction` for the writes: `ensureName` (creates the name row
if it is new), `recordEvent` a `login` entry, then create the session, set the cookie,
`broadcastActivity`. A `409` writes nothing. A returning name (`200`) still gets a
`login` entry because it is a new session; the same-browser retry above gets none.

`201` versus `200` is informational only — both mean "you are logged in" and the client
treats them identically. It tells a caller whether the name had been used before.

A reload or retried request from a browser whose cookie is still valid hits the
same-session row and writes nothing. Two ENTER taps cannot reach the server twice because
the login screen ignores keys while `busy`; if they did, the second one would see the
first session as live and be refused, which is why the UI guard matters.

### `GET /api/session/availability`

`?name=USER1` → `200 { "available": true }`, where `false` means **another live session
holds it right now**. A known name whose owner has signed out is available: reuse is
allowed. No session required, creates nothing (no `user_names` row), same `^[A-Z]{3,20}$`
validation (`400 INVALID_NAME` otherwise), writes no log row. Nothing about it is
authoritative: it exists so the login page can warn while the user is typing, before they
lose a multi-tap entry to a refusal.

### `GET /api/session`

`200 { "session": { "userName": "USER1" } }` or `401 NOT_AUTHENTICATED`.

### `DELETE /api/session`

`204`, `Set-Cookie: atm_sid=; Path=/; Max-Age=0`, one `logout` entry, then
`broadcastActivity`. With no session it is still `204` and writes nothing — signing out
twice is not an event.

### Gating

`requireSession` reads the cookie, looks up the session and attaches
`res.locals.session`, or responds `401 NOT_AUTHENTICATED`. Applied to every `/api`
route except `/api/health`, `POST /api/session` and `GET /api/session/availability`.
`GET /api/account` becomes protected here.

## 4. Client

`api.ts`:

```ts
export class HttpError extends Error { status: number; code: string }
export async function login(name: string): Promise<{ userName: string }>;
export async function nameAvailable(name: string): Promise<boolean>;
export async function currentSession(): Promise<{ userName: string } | null>;
export async function logout(): Promise<void>;
export async function getAccount(): Promise<Account>;
```

One `request()` helper: `fetch` with `Content-Type: application/json` and
`credentials: "same-origin"`. A `01` §6.1 error body becomes
`HttpError(status, code, message)`; anything else becomes
`HttpError(0, "NETWORK", "Cannot reach the ATM server.")`. `currentSession` returns
`null` on 401 — "not logged in" is a normal boot state. No retries, no caching.

**Boot.** `busy = true`, login screen with `Checking session…`, then `currentSession()`
and either `reduce({ type: "login", userName })` or stay on `login`. A `NETWORK`
failure shows `Cannot reach the ATM server.` in the banner.

**Login screen.**

- `enter` runs the local 3–20 check first, then `POST /api/session`.
- While in flight `busy = true`, display reads `Signing in…`, keys are ignored.
- Success: set `userName`, reset `input`, clear the banner, go `home`, then
  `getAccount()`, then `refreshSession()` (05) so the socket handshake picks up the new
  cookie.
- `409`/`400`: banner is the server's `message`, stay on `login`, keep the typed name so
  BACK can fix it.
- **Early warning while typing.** After every change, a 500 ms debounce calls
  `nameAvailable(shownText)` when the name has at least 3 characters. `false` sets
  `That name is already in use. Try another name.`, `true` clears the banner. A reply
  is ignored unless its name still matches what is on screen, so a slow answer for
  `ALE` cannot overwrite the warning for `ALEX`. The check never blocks ENTER, never
  changes the screen, is silent on `NETWORK`, and is cancelled when the screen is left
  or the entry drops below 3 characters.

**Home screen**, rendered from state:

```
WELCOME, USER1
Balance
$1,000.00
        [ Withdraw ]  [ Deposit ]  [ Sign out ]
```

- Balance is `formatAUD(state.balanceCents)` via `src/client/ui/money.ts`, added by this
  slice with the same output as the server's.
- Buttons are real `<button>`s in `.atm__actions` under the display, inside the frame.
  They are disabled while `busy` and while a transaction is in progress; they stay
  enabled while someone *else* holds the lock (slice 07) so the user gets the
  explanation instead of a dead button.
- `Sign out` calls `logout()`, resets to login, clears the typed name, calls
  `refreshSession()`, and shows `You are signed out.`
- Entering `home` always refreshes with `getAccount()`; a failed refresh keeps the last
  balance and shows `Balance may be out of date.` — the recovery path when the socket
  is down.

**401 anywhere** resets to login with `Session ended. Please log in again.` This is the
only place the client reacts to an error code instead of showing the message.

## 5. Log output of this slice

```
USER1: Logged in at 12:30:45
USER1: Logged out at 12:41:00
```

Both are written by route handlers, never by the client, so a client cannot claim an
event that did not happen.

## 6. Tests

`tests/server/sessions.test.ts`
- distinct ids; `getSession` round-trips and updates `lastSeenMs`; `destroySession`
  makes it `null`.
- `readSessionId` handles `"atm_sid=abc"`, `"a=1; atm_sid=abc; b=2"`, `""`, `undefined`
  and `"atm_sid="` (→ `null`).
- `setSessionSockets(id, 0)` starts the absence clock, `(id, 1)` clears it; a session
  absent past `SESSION_GRACE_MS` is dead (`getSession` → `null`) while one inside the
  grace is alive.
- `sweepSessions` destroys only sessions past the grace, returns them, and a second
  sweep destroys nothing.

`tests/server/names.test.ts` (fresh `:memory:` db)
- `ensureName` returns `true` the first time and `false` the second, leaving one row.
- close and reopen the same file database → the row is still there, `ensureName` returns
  `false`, and the original `used_at_ms` is unchanged.

`tests/server/session-routes.test.ts` (Supertest on `createApp({ db })`)
- new name → 201, `Set-Cookie` present, one `login` row and one `user_names` row.
- a known name after sign-out → 200, new `Set-Cookie`, a new `login` row, and still one
  `user_names` row with the same name (the identity is reused, not duplicated).
- the same name after a database reopen → 200, same single row.
- `"AB"` and `"user1"` → 400 `INVALID_NAME`, no row written in either table.
- `GET /api/session` with and without the cookie; `GET /api/account` without → 401.
- `DELETE` → 204, cookie cleared, one `logout` row; a second `DELETE` → 204 and still
  one row.
- **In use:** A is logged in as `USER1`; B posting `USER1` → 409, no `Set-Cookie`, no
  second row, and B's `GET /api/session` is still 401. `USER10` stays available.
- **Released:** A signs out, B posts `USER1` → 200. With a small `SESSION_GRACE_MS`, A's
  `setSessionSockets(A, 0)` plus a sweep also releases it.
- **Idempotent:** A posts `USER1` again with its own cookie → 200, no second `login` row.
- **Race:** 20 agents post `USER1` with `Promise.all` → one 201, nineteen 409, one
  `login` row, one `user_names` row.
- **Availability:** `true` before any login, `false` while A holds it, `true` again after
  A signs out; no cookie needed; `?name=ab` → 400; writes no log row.

`tests/client/router.test.ts` (extended)
- `login` success sets `screen: "home"` and `userName`.
- `nameTaken` sets `banner` to the server message, keeps `login` and the typed name.
- `signOut` returns to `login` and clears `userName` and `input`.

## 7. Acceptance criteria

- [ ] Two browsers log in with different names; both homepages show `$1,000.00`.
- [ ] A third browser tries a name while that user is logged in: after the third letter
      the display warns, ENTER is refused with the same message, the name stays editable.
- [ ] Sign that user out; the third browser (or the same one) can log in with that name.
      Close the tab instead: the name frees itself about a minute later.
- [ ] Sign out and back in as the same name, then check the log: every row says that name,
      and `select name from user_names` lists it exactly once.
- [ ] Reloading keeps the user on the homepage — no second login screen.
- [ ] Signing out in one browser does not sign out the other.
- [ ] `sqlite3 data/atm.db "select event_type,user_name,local_time from activity_log"`
      shows one `login` per login and one `logout` per sign-out, in order, and **no**
      row for a refused attempt.
- [ ] A 2-letter name is refused with a readable message and no log row.
- [ ] Restarting the server sends every browser back to login on its next request with
      the `Session ended` banner; the balance and the names survive, and the same name
      can be used again.
- [ ] `npm test` passes.
