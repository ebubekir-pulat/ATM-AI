# 04 — Login, Sessions and Homepage

**Depends on:** `02`, `03`.
**Delivers:** a working login with multi-tap names, server-side sessions in a
cookie, the homepage with the live balance and its three buttons, sign out, and
`login` / `logout` entries in the activity log.
**Covers:** `specs.txt` §3 (authentication), §5 (homepage), §11 (sign out), and the
session half of §11's "handle unexpected disconnects".

---

## 1. Flow

```
page load
   └─ GET /api/session ── 200 ──> home (name from the cookie's session)
                        └─ 401 ──> login
login screen
   ├─ typing (3+ letters) ── GET /api/session/availability ──> "already in use" warning
   └─ ENTER ── POST /api/session { name }
                 ├─ 201 ──> home + login entry in the log
                 ├─ 409 NAME_TAKEN ──> banner on the login screen, name kept
                 └─ 400 ──> banner on the login screen, name kept
home
   ├─ Withdraw  -> slice 06/07
   ├─ Deposit   -> slice 06/07
   └─ Sign out  -> DELETE /api/session ── 204 ──> login + logout entry in the log
```

## 2. Files

Modify: `src/client/main.ts` (boot sequence), `src/client/state.ts` (session
actions), `src/client/screens/login.ts`, `src/client/screens/home.ts`.
Create: `src/client/api.ts`, `src/server/sessions.ts`,
`src/server/http/requireSession.ts`, `src/server/http/routes/session.ts`.
Modify: `src/server/app.ts` (mount the session routes and gate the account route).
Tests: `tests/server/sessions.test.ts`, `tests/server/session-routes.test.ts`,
`tests/client/router.test.ts` (extend).

## 3. `sessions.ts`

In memory only (see `01` §8 for why):

```ts
export interface Session {
  id: string; userName: string; createdAtMs: number; lastSeenMs: number;
  sockets: number;               // connected sockets, maintained by realtime.ts
  absentSinceMs: number | null;  // set when the last socket disconnects
}
export function createSession(userName: string, nowMs?: number): Session;
export function getSession(id: string | null, nowMs?: number): Session | null;
export function findSessionByName(userName: string, nowMs?: number): Session | null;
export function isNameTaken(userName: string, nowMs?: number): boolean;
export function setSessionSockets(id: string, count: number, nowMs?: number): void;
export function destroySession(id: string): void;
export function readSessionId(cookieHeader: string | undefined): string | null;
export function sweepSessions(nowMs: number): Session[]; // returns the destroyed ones
```

- `id` is `crypto.randomUUID()`. It is the only thing in the cookie; it carries
  no user data.
- `createSession` starts a session with `sockets: 0` and `absentSinceMs: now`, so a
  session that never manages to connect cannot hold its name forever. The next
  request or socket connection clears the clock.
- `readSessionId` parses the `Cookie` header for `atm_sid`, tolerating spaces,
  other cookies and a missing header. It returns `null` rather than throwing.
- `getSession` returns `null` when the session is gone. Otherwise it updates
  `lastSeenMs` and clears `absentSinceMs`: a request proves the person is still
  there.
- **Liveness rule, used by everything above.** A session is live unless it has no
  connected socket (`sockets === 0`) and `now - absentSinceMs > SESSION_GRACE_MS`.
  `setSessionSockets(id, 0)` starts the countdown; `setSessionSockets(id, n > 0)`
  clears it. `sweepSessions` is called every 5 s from `index.ts` and destroys the
  sessions past their grace.
- **A name is taken exactly as long as its session is live.** `isNameTaken` and
  `findSessionByName` apply the same rule and drop expired sessions as they go, so a
  name frees itself one grace period after its holder's last tab closes. Comparison
  is exact (`USER1` ≠ `USER10`); names are already uppercase.
- `setSessionSockets` on an unknown or already-destroyed id is a no-op: a socket
  that disconnects after its session was signed out must not throw.
- Sweeping and expiry write **no `logout` entry** — the person did not sign out, and
  claiming they did would be an event the log cannot support. Slice 07 releases any
  lock the swept session held.
- Sessions do **not** survive a server restart: the balance and the log do, the
  cookie does not. A restart simply sends everyone to the login screen.

Reasons pinned here: a signed cookie or a database table would both be more
machinery than a LAN demo needs, and a restart is a natural way to clear a stale
session. Nothing in the source spec requires sessions to persist.

Why uniqueness is tied to liveness rather than to a stored record: there are no
accounts, so a name belongs to the person logged in right now, not to a permanent
record. If a browser crashes, tying the name to a record would lock that person out
until someone edited the database; tying it to the live session frees the name a
minute after the tab closes and never leaves the demo stuck.

## 4. Routes

### `POST /api/session`

```ts
// request
{ "name": "USER1" }
// 201
{ "session": { "userName": "USER1" } }
// Set-Cookie: atm_sid=<uuid>; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400
```

Validation and uniqueness, in this order, responding as shown:

| Condition | Status / code | `message` |
|-----------|---------------|-----------|
| body is not an object, or `name` is not a string | 400 `INVALID_NAME` | `Enter your name.` |
| not `^[A-Z]{3,20}$` after trimming | 400 `INVALID_NAME` | `Name must be 3 to 20 letters (A-Z).` |
| the caller's own live session already has this name | `200` | — (returns that session, no new entry) |
| the caller's live session has a **different** name | 400 `INVALID_NAME` | `Sign out before signing in with another name.` |
| another live session has this name | 409 `NAME_TAKEN` | `That name is already in use. Try another name.` |

Trimming is `String.prototype.trim()` only. Uppercasing is the caller's job
(the keypad produces A–Z), so a lowercase name is rejected rather than silently
changed — the request is wrong, not the user.

The uniqueness check and the session creation are **synchronous, with no `await`
between them**. Node runs one request at a time through that stretch, so two people
pressing ENTER on the same name at the same instant cannot both get 201 — the same
argument as `lock.acquire` in slice 07.

Side effects on a `201`, in this order: create the session, set the cookie,
`recordEvent` a `login` entry, `broadcastActivity` it. The response is sent after
the log write. A `409` writes nothing.

A double-tap of ENTER, a reload, or a retried request from the same browser is
idempotent: the cookie's session already has that name, so it gets `200` and no
second `login` entry.

### `GET /api/session/availability`

`?name=USER1` → `200 { "available": true }`. No session required, and it creates
nothing. Same `^[A-Z]{3,20}$` validation, so a malformed name is
`400 INVALID_NAME`; the login screen only calls it at three or more letters.
Nothing about it is authoritative — it exists so the login page can warn while the
user is still typing, before they lose a multi-tap entry to a refusal.

### `GET /api/session`

`200 { "session": { "userName": "USER1" } }`, or `401 NOT_AUTHENTICATED`.

### `DELETE /api/session`

`204`, `Set-Cookie: atm_sid=; Path=/; Max-Age=0`, `recordEvent` a `logout`
entry, `broadcastActivity`. If there is no session, still `204` and no entry —
signing out twice is not an event.

### Gating

`requireSession` reads the cookie, looks up the session, and either attaches
`socket`-free context (`res.locals.session`) or responds `401 NOT_AUTHENTICATED`.
It is applied to every `/api` route except `/api/health`, `POST /api/session` and
`GET /api/session/availability`. `GET /api/account` becomes protected in this slice.

## 5. Client

### `api.ts`

```ts
export class HttpError extends Error { status: number; code: string }
export async function login(name: string): Promise<{ userName: string }>;
export async function nameAvailable(name: string): Promise<boolean>;
export async function currentSession(): Promise<{ userName: string } | null>;
export async function logout(): Promise<void>;
export async function getAccount(): Promise<Account>;
```

- One `request()` helper: `fetch` with `headers: { "Content-Type": "application/json" }`
  and `credentials: "same-origin"`. Errors of the `01` §6.1 shape become
  `HttpError(status, code, message)`; anything else becomes `HttpError(0, "NETWORK", "Cannot reach the ATM server.")`.
- `currentSession` returns `null` on `401` instead of throwing: "not logged in"
  is a normal boot state.
- No retries, no caching.

### Boot

`main.ts` sets `busy = true`, shows the login screen with `Checking session…`,
calls `currentSession()`, then either `reduce({type:"login", userName})` (home) or
stays on `login`. A `NETWORK` failure shows the login screen with
`Cannot reach the ATM server.` in `banner`.

### Login screen

- `enter` runs the existing local validation from slice 03 first (3–20 letters),
  then `POST /api/session`.
- While the request is in flight `busy = true`: the display shows `Signing in…`
  and keys are ignored (the keypad already guards on `busy`).
- On success: `state.userName = name`, `state.input = createMultiTap()`,
  clear the banner, go to `home`, then `getAccount()`, then `refreshSession()`
  (slice 05) so the socket handshake picks up the new cookie.
- On `409 NAME_TAKEN` or `400`: `banner` = the server's `message`, stay on `login`,
  keep the typed name so the user can correct it with BACK.
- **Early warning while typing.** After every change to the typed name, a 500 ms
  debounce (`clearTimeout` + `setTimeout`) calls `nameAvailable(shownText)`, but only
  when the name is at least 3 characters. If the answer is `false` the banner reads
  `That name is already in use. Try another name.`; if it is `true` the banner is
  cleared. The reply is ignored unless its name still matches what is on screen, so
  a slow response for `ALE` cannot overwrite the warning for `ALEX`.
- The check never blocks ENTER and never changes the screen. The `POST` is the only
  thing that decides. If the check is still in flight, ENTER just goes ahead.
- A `NETWORK` failure of the check is silent: no banner, ENTER still works. A phone
  that loses Wi-Fi for a second should not see a scary message about a name.
- The debounce is cancelled when the login screen is left or the entry drops below
  three characters, so no request is ever sent for an empty name.
- On `NETWORK`: `banner` = `Cannot reach the ATM server.`

### Home screen

Rendered from state, top to bottom:

```
WELCOME, USER1

Balance        <- label
$1,000.00      <- large, from the server

        [ Withdraw ]
        [ Deposit  ]
        [ Sign out ]
```

- Balance is `formatAUD(state.balanceCents)`; slice 03 already has the formatter
  mirrored on the client (`src/client/ui/money.ts`, added by this slice, same
  output as the server's).
- Buttons are real `<button>` elements in `.atm__actions` under the display, inside
  the ATM frame. They are disabled while `busy` is true, and while a withdrawal or
  deposit is already in progress (slice 07 adds the "account is locked" case; the
  buttons stay enabled then so the user gets the explanatory message instead of a
  dead button).
- `Sign out` calls `logout()`, resets state to the login screen, clears the typed
  name, calls `refreshSession()` (slice 05) so the socket drops the old session id,
  and shows the banner `You are signed out.`
- Entering `home` always refreshes the balance with `getAccount()`; a failed
  refresh keeps the last known balance and shows `Balance may be out of date.` in
  the banner. Slice 05 makes this unnecessary most of the time but keeps it as the
  recovery path.

### 401 anywhere

Any request that returns `401 NOT_AUTHENTICATED` resets to the login screen with
the banner `Session ended. Please log in again.` This is the only place the client
reacts to an error code rather than showing the message.

## 6. Log output of this slice

```
USER1: Logged in at 12:30:45
USER1: Logged out at 12:41:00
```

Both are written by the route handlers, not by the client, so a client cannot
claim an event that did not happen.

## 7. Tests

`tests/server/sessions.test.ts`
- `createSession` returns distinct ids; `getSession` round-trips and updates
  `lastSeenMs`; `destroySession` makes it `null`.
- `readSessionId` handles `"atm_sid=abc"`, `"a=1; atm_sid=abc; b=2"`, `""`,
  `undefined`, and `"atm_sid="` (→ `null`).
- `isNameTaken` is true only for a live session with that exact name;
  `findSessionByName` returns it and `null` for an unknown name.
- `setSessionSockets(id, 0)` starts the absence clock and
  `setSessionSockets(id, 1)` clears it; a session absent longer than
  `SESSION_GRACE_MS` is dead (`getSession` → `null`, `isNameTaken` → `false`),
  while one inside the grace is still alive.
- `sweepSessions` destroys only sessions past `SESSION_GRACE_MS` and returns them;
  sweeping twice destroys nothing the second time.

`tests/server/session-routes.test.ts` (Supertest on `createApp({ db })`)
- `POST` valid name → 201, `Set-Cookie` present, one `login` row.
- `POST` `"AB"` → 400 `INVALID_NAME`; `POST` `"user1"` → 400; no row written.
- `GET /api/session` with and without the cookie.
- `DELETE /api/session` → 204, cookie cleared, one `logout` row; a second
  `DELETE` → 204 and still only one row.
- `GET /api/account` without a cookie → 401 `NOT_AUTHENTICATED`.
- **Unique names:** agent A logs in as `USER1`; agent B posting `USER1` →
  409 `NAME_TAKEN`, no `Set-Cookie`, no second `login` row, and `GET /api/session`
  as B is still 401. `USER10` is still available (prefix is not a match).
- **Idempotent retry:** agent A posts `USER1` twice → 201 then 200, and exactly one
  `login` row.
- **Name freed:** A signs out, B posts `USER1` → 201. And with
  `SESSION_GRACE_MS` small, A's last socket disconnecting (or `setSessionSockets(A,
  0)` plus a tick) frees the name without a sign-out.
- **Race:** 20 agents post `USER1` concurrently with `Promise.all` → exactly one
  201, nineteen 409, and exactly one `login` row.
- **Availability:** `GET /api/session/availability?name=USER1` before any login →
  `{"available":true}`; while A holds `USER1` → `"available":false`; no cookie is
  required; `?name=ab` → 400 `INVALID_NAME`; the endpoint writes no log row.

`tests/client/router.test.ts` (extended)
- `login` success action sets `screen: "home"` and `userName`.
- `nameTaken` action sets `banner` to the server message, keeps `screen: "login"`
  and keeps the typed name so it can be edited.
- `signOut` action returns to `login` and clears `userName` and `input`.

## 8. Acceptance criteria

- [ ] Open two browsers. Both log in (different names). Both homepages show the
      same `$1,000.00`.
- [ ] A third browser tries an already logged-in name: after the third letter the
      display already reads `That name is already in use.` and ENTER is refused with
      the same message — still on the login screen, name still editable.
- [ ] Sign that name out; the third browser can now log in with it (the availability
      warning clears).
- [ ] Close the third browser's tab without signing out; after about a minute the
      name is free again for someone else.
- [ ] Reloading the page keeps the user on the homepage — no second login screen.
- [ ] Signing out in one browser does not sign out the other.
- [ ] `sqlite3 data/atm.db "select event_type,user_name,local_time from activity_log"`
      shows a `login` per login and a `logout` per sign-out, in order, and **no**
      entry for a refused duplicate name.
- [ ] A 2-letter name is refused with a readable message and no log entry.
- [ ] Signing out, then navigating to `/` shows the login screen.
- [ ] Restarting the server sends every browser back to login on its next request,
      with the `Session ended` banner, and the balance is unchanged.
- [ ] `npm test` passes.
