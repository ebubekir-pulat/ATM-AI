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
   └─ ENTER ── POST /api/session { name } ── 201 ──> home + login entry in the log
                                          └─ 400 ──> banner on the login screen
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
export interface Session { id: string; userName: string; createdAtMs: number; lastSeenMs: number }
export function createSession(userName: string): Session;
export function getSession(id: string | null): Session | null; // touches lastSeenMs
export function destroySession(id: string): void;
export function readSessionId(cookieHeader: string | undefined): string | null;
export function sweepIdleSessions(nowMs: number): Session[]; // returns the removed ids' sessions
```

- `id` is `crypto.randomUUID()`. It is the only thing in the cookie; it carries
  no user data.
- `readSessionId` parses the `Cookie` header for `atm_sid`, tolerating spaces,
  other cookies and a missing header. It returns `null` rather than throwing.
- `getSession` updates `lastSeenMs`, so any request keeps the session alive.
- `sweepIdleSessions` removes sessions idle longer than `SESSION_IDLE_MS`
  (new constant: `24 * 60 * 60 * 1000`, added to `config.ts`), called from a
  `setInterval(…, 60000)` started in `index.ts`. **Removal writes no `logout`
  entry** — the user did not sign out; the entry would be a claim the log cannot
  support. Slice 07 releases any lock the swept session held.
- Sessions do **not** survive a server restart: the balance and the log do, the
  cookie does not. A restart simply sends everyone to the login screen.

Reasons pinned here: a signed cookie or a database table would both be more
machinery than a LAN demo needs, and a restart is a natural way to clear a stale
session. Nothing in the source spec requires sessions to persist.

## 4. Routes

### `POST /api/session`

```ts
// request
{ "name": "USER1" }
// 201
{ "session": { "userName": "USER1" } }
// Set-Cookie: atm_sid=<uuid>; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400
```

Validation, in this order, each failure a `400 INVALID_NAME` with the message
shown:

| Condition | `message` |
|-----------|-----------|
| body is not an object, or `name` is not a string | `Enter your name.` |
| not `^[A-Z]{3,20}$` after trimming | `Name must be 3 to 20 letters (A-Z).` |

Trimming is `String.prototype.trim()` only. Uppercasing is the caller's job
(the keypad produces A–Z), so a lowercase name is rejected rather than silently
changed — the request is wrong, not the user.

Side effects, in this order: create the session, set the cookie, `recordEvent`
a `login` entry, `broadcastActivity` it. The response is sent after the log write.

Creating a second session from the same browser (a second tab, or a reload after
the cookie was lost) creates a new session id and another `login` entry. That is
accurate: it is another login.

Two people may log in with the same name. Names identify a person in the log;
they are not credentials, and the source spec asks for no uniqueness.

### `GET /api/session`

`200 { "session": { "userName": "USER1" } }`, or `401 NOT_AUTHENTICATED`.

### `DELETE /api/session`

`204`, `Set-Cookie: atm_sid=; Path=/; Max-Age=0`, `recordEvent` a `logout`
entry, `broadcastActivity`. If there is no session, still `204` and no entry —
signing out twice is not an event.

### Gating

`requireSession` reads the cookie, looks up the session, and either attaches
`socket`-free context (`res.locals.session`) or responds `401 NOT_AUTHENTICATED`.
It is applied to every `/api` route except `/api/health` and `POST /api/session`.
`GET /api/account` becomes protected in this slice.

## 5. Client

### `api.ts`

```ts
export class HttpError extends Error { status: number; code: string }
export async function login(name: string): Promise<{ userName: string }>;
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
  go to `home`, then `getAccount()`.
- On `400`: `banner` = the server's `message`, stay on `login`, keep the typed name
  so the user can correct it with BACK.
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
  name, and shows the banner `You are signed out.`
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
- `sweepIdleSessions` removes only sessions older than `SESSION_IDLE_MS`.

`tests/server/session-routes.test.ts` (Supertest on `createApp({ db })`)
- `POST` valid name → 201, `Set-Cookie` present, one `login` row.
- `POST` `"AB"` → 400 `INVALID_NAME`; `POST` `"user1"` → 400; no row written.
- `GET /api/session` with and without the cookie.
- `DELETE /api/session` → 204, cookie cleared, one `logout` row; a second
  `DELETE` → 204 and still only one row.
- `GET /api/account` without a cookie → 401 `NOT_AUTHENTICATED`.
- `POST /api/session` while the name already exists as a session → 201 (same name,
  new session).

`tests/client/router.test.ts` (extended)
- `login` success action sets `screen: "home"` and `userName`.
- `signOut` action returns to `login` and clears `userName` and `input`.

## 8. Acceptance criteria

- [ ] Open two browsers. Both log in (different names). Both homepages show the
      same `$1,000.00`.
- [ ] Reloading the page keeps the user on the homepage — no second login screen.
- [ ] Signing out in one browser does not sign out the other.
- [ ] `sqlite3 data/atm.db "select event_type,user_name,local_time from activity_log"`
      shows a `login` per login and a `logout` per sign-out, in order.
- [ ] A 2-letter name is refused with a readable message and no log entry.
- [ ] Signing out, then navigating to `/` shows the login screen.
- [ ] Restarting the server sends every browser back to login on its next request,
      with the `Session ended` banner, and the balance is unchanged.
- [ ] `npm test` passes.
