# 04 — Login, Sessions and Homepage

**Depends on:** `02`, `03`
**Delivers:** Login with multi-tap names, server-side cookie sessions, homepage with live balance and three buttons (Withdraw, Deposit, Sign out), and login/logout log entries
**Covers:** `specs.txt` §3, §5, §11 including "handle unexpected disconnects"

---

## 1. Flow

```
Load page     → GET /api/session
    ├─ 200    → Home
    └─ 401    → Login

Login screen:
    Type 3+ chars → GET /api/session/availability?name=X
                        false → "in use" banner (only while live)

    Press Enter → POST /api/session {name}
        ├─ 201 (new)    → Home + login entry
        ├─ 200 (known)  → Home + login entry
        ├─ 409 taken    → banner, stay, keep name
        └─ 400 invalid  → banner, stay, keep name

Home:
    Withdraw / Deposit → slices 06/07
    Sign out → DELETE /api/session → 204 → Login + logout entry
```

**Files to create:** `src/client/api.ts`, `src/server/sessions.ts`, `src/server/names.ts`, `src/server/http/requireSession.ts`, `src/server/http/routes/session.ts`
**Files to modify:** `app.ts`, `main.ts`, `state.ts`, `screens/{login,home}.ts`
**Tests:** `tests/server/{sessions,names,session-routes}.test.ts`, `tests/client/router.test.ts`

---

## 2. Sessions and Names

### `sessions.ts` — In-memory sessions

- **Session ID:** `crypto.randomUUID()`, stored only in cookie (`atm_sid`). No user data in cookie.
- **`createSession`** starts with `sockets: 0`, `absentSinceMs: now`. Sessions that never connect are swept. Next request/socket clears the clock.
- **`readSessionId`** parses `Cookie` header for `atm_sid`, tolerating spaces, other cookies, missing header. Returns `null` (never throws).
- **`getSession`** returns `null` if gone; otherwise refreshes `lastSeenMs`, clears `absentSinceMs` (request proves presence).
- **Liveness rule:** A session is live **unless** `sockets === 0` AND `now - absentSinceMs > SESSION_GRACE_MS`.
  - `setSessionSockets(id, 0)` starts grace countdown
  - `setSessionSockets(id, n > 0)` clears it
  - `index.ts` calls `sweepSessions` every 5s
- **`setSessionSockets` on unknown/destroyed ID** is a no-op (socket disconnect after sign-out must not throw).
- **Name held = session live.** `findSessionByName` applies liveness rule. Returns holder of `SIMON` or `null` if session gone. Exact match (`SIMON` ≠ `ALEX`).
- **Sweeping/expiry writes NO `logout` entry** — person didn't sign out. Slice 07 releases any lock held by swept session.
- **Sessions don't survive restart**; balance, log, and names do.

### `names.ts` — Persistent identity registry

- **`ensureName(db, name, nowMs?)`** — `INSERT INTO user_names (name, used_at_ms) ON CONFLICT DO NOTHING`. Returns `true` if inserted. One row per name, created on first login, reused forever.
- **Names never deleted.** `SIMON` today and next week produce log rows with same `user_name` — the name IS the log identity.

### Two rules, both matter:

| Rule | Enforced by |
|------|-------------|
| One row per name, reused by whoever types it | Primary key on `user_names` |
| No two live sessions hold same name | `findSessionByName` in `POST /api/session` |

Signing out (or sweep) frees name for **reuse**, not ownership. Row stays → next `SIMON` is same `SIMON` in log. No passwords → server can't tell if same human. Name is a label; log records exactly what was typed.

---

## 3. Routes

### `POST /api/session`

**Request:** `{ "name": "SIMON" }`

**Success (201 new / 200 known):** `{ "session": { "userName": "SIMON" } }` + `Set-Cookie: atm_sid=<uuid>; HttpOnly; Path=/; SameSite=Lax; Max-Age=1800`

**Validation order:**

| Condition | Status / Code | Message |
|-----------|---------------|---------|
| Body not object, or `name` not string | 400 `INVALID_NAME` | `Enter your name.` |
| Not `^[A-Z]{3,20}$` after trim | 400 `INVALID_NAME` | `Name must be 3 to 20 letters (A-Z).` |
| Caller's live session already has this name | 200 | — (no new session, no new entry) |
| Caller's live session has **different** name | 400 `INVALID_NAME` | `Sign out before signing in with another name.` |
| Another live session holds this name | 409 `NAME_TAKEN` | `That name is already in use. Try another name.` |
| Otherwise | 201 (new) / 200 (known) | — |

- Trim only (`String.prototype.trim()`). Uppercase is caller's job (keypad produces A–Z). Lowercase rejected, not silently changed.
- **Liveness check + session creation are synchronous (no `await` between)** → two people pressing ENTER on same name at same instant cannot both get a session.
- **Side effects (one `db.transaction`):** `ensureName` → `recordEvent(login)` → create session → set cookie → `broadcastActivity`.
  - `409` writes nothing
  - Returning name (`200`) still gets `login` entry (new session); same-browser retry gets none
- **201 vs 200** is informational only — both mean "logged in", client treats identically. Tells caller if name was used before.
- Reload/retry with valid cookie hits same session, writes nothing. Double ENTER can't reach server twice (login screen ignores keys while `busy`); if it did, second sees first session as live and is refused.

### `GET /api/session/availability`

`?name=SIMON` → `200 { "available": true }` where `false` = another live session holds it **right now**. Known name whose owner signed out = available (reuse allowed). No session required, creates nothing, same validation (`400 INVALID_NAME` if invalid), writes no log row. **Not authoritative** — exists for login page to warn while typing, before user loses multi-tap entry to refusal.

### `GET /api/session`

`200 { "session": { "userName": "SIMON" } }` or `401 NOT_AUTHENTICATED`

### `DELETE /api/session`

`204`, `Set-Cookie: atm_sid=; Path=/; Max-Age=0`, one `logout` entry, then `broadcastActivity`. No session → still `204`, writes nothing (signing out twice is not an event).

### Gating

`requireSession` reads cookie, looks up session, attaches `res.locals.session`, or responds `401 NOT_AUTHENTICATED`. Applied to **every `/api` route except**: `/api/health`, `POST /api/session`, `GET /api/session/availability`. `GET /api/account` becomes protected here.

---

## 4. Client

### `api.ts`

```ts
export class HttpError extends Error { status: number; code: string }
export async function login(name: string): Promise<{ userName: string }>
export async function nameAvailable(name: string): Promise<boolean>
export async function currentSession(): Promise<{ userName: string } | null>
export async function logout(): Promise<void>
export async function getAccount(): Promise<Account>
```

**One `request()` helper:** `fetch` with `Content-Type: application/json`, `credentials: "same-origin"`. Error body → `HttpError(status, code, message)`; anything else → `HttpError(0, "NETWORK", "Cannot reach the ATM server.")`. `currentSession` returns `null` on 401 (normal boot state). No retries, no caching.

### Boot

`busy = true`, login screen shows `Checking session…`, then `currentSession()` → either `reduce({ type: "login", userName })` or stay on `login`. `NETWORK` failure shows `Cannot reach the ATM server.` in banner.

### Login Screen

- **Enter:** Local 3–20 check first, then `POST /api/session`.
- **In flight:** `busy = true`, display `Signing in…`, keys ignored.
- **Success:** Set `userName`, reset `input`, clear banner, go `home`, then `getAccount()`, then `refreshSession()` (slice 05) so socket handshake picks up new cookie.
- **409/400:** Banner = server's `message`, stay on `login`, keep typed name (BACK can fix).
- **Early warning while typing:** After every change, 500ms debounce calls `nameAvailable(shownText)` when name ≥3 chars.
  - `false` → banner `That name is already in use. Try another name.`
  - `true` → clears banner
  - Reply ignored unless name still matches screen (slow `ALE` reply can't overwrite `ALEX` warning)
  - Never blocks ENTER, never changes screen, silent on `NETWORK`, cancelled when screen left or entry <3 chars.

### Home Screen

```
WELCOME, SIMON
Balance
$1,000.00
        [ Withdraw ]  [ Deposit ]  [ Sign out ]
```

- Balance = `formatAUD(state.balanceCents)` via `src/client/ui/money.ts` (same output as server).
- Buttons = real `<button>`s in `.atm__actions` under display, inside frame. Disabled while `busy` or transaction in progress; **stay enabled** while someone else holds lock (slice 07) so user gets explanation, not dead button.
- **Sign out:** Calls `logout()`, resets to login, clears typed name, calls `refreshSession()`, shows `You are signed out.`
- **Entering home** always refreshes with `getAccount()`. Failed refresh takes user back to login.

### 401 Anywhere

Resets to login with `Session ended. Please log in again.` **Only place** client reacts to error code instead of showing message.

---

## 5. Log Output

```
SIMON: Logged in at 12:30:45
SIMON: Logged out at 12:41:00
```

Both written by route handlers, **never by client** → client cannot claim event that didn't happen.

---

## 6. Tests

### `tests/server/sessions.test.ts`
- Distinct IDs; `getSession` round-trips and updates `lastSeenMs`; `destroySession` makes it `null`
- `readSessionId` handles `"atm_sid=abc"`, `"a=1; atm_sid=abc; b=2"`, `""`, `undefined`, `"atm_sid="` → `null`
- `setSessionSockets(id, 0)` starts absence clock, `(id, 1)` clears it; session absent past `SESSION_GRACE_MS` is dead (`getSession` → `null`); inside grace = alive
- `sweepSessions` destroys only sessions past grace, returns them; second sweep destroys nothing

### `tests/server/names.test.ts` (fresh `:memory:` db)
- `ensureName` returns `true` first time, `false` second, leaves one row
- Close/reopen same file DB → row persists, `ensureName` returns `false`, original `used_at_ms` unchanged

### `tests/server/session-routes.test.ts` (Supertest on `createApp({ db })`)
- New name → 201, `Set-Cookie` present, one `login` row, one `user_names` row
- Known name after sign-out → 200, new `Set-Cookie`, new `login` row, still one `user_names` row (identity reused, not duplicated)
- Same name after DB reopen → 200, same single row
- `"AB"` and `"user1"` → 400 `INVALID_NAME`, no row written in either table
- `GET /api/session` with cookie → 200; without cookie → 401
- `GET /api/account` without cookie → 401 (protected by `requireSession`)
- `DELETE` → 204, cookie cleared, one `logout` row; second `DELETE` → 204, still one row
- **In use:** A logged in as `SIMON`; B posts `SIMON` → 409, no `Set-Cookie`, no second row, B's `GET /api/session` still 401. `ALEX` stays available.
- **Released:** A signs out, B posts `SIMON` → 200. With small `SESSION_GRACE_MS`, A's `setSessionSockets(A, 0)` + sweep also releases it.
- **Idempotent:** A posts `SIMON` again with own cookie → 200, no second `login` row.
- **Race:** 20 agents post `SIMON` with `Promise.all` → one 201, nineteen 409, one `login` row, one `user_names` row.
- **Availability:** `true` before login, `false` while A holds it, `true` after A signs out; no cookie needed; `?name=ab` → 400; writes no log row.

### `tests/client/router.test.ts` (extended)
- Login success → `screen: "home"`, `userName` set
- `nameTaken` → banner = server message, keeps `login` and typed name
- `signOut` → returns to `login`, clears `userName` and `input`

---

## 7. Acceptance Criteria

- [ ] Two browsers log in with different names; both homepages show `$1,000.00`
- [ ] Third browser tries name while user logged in: after 3rd letter display warns, ENTER refused with same message, name stays editable
- [ ] Sign that user out; third browser (or same) can log in with that name. Close tab instead: name frees itself ~1 minute later
- [ ] Sign out and back in as same name; check log: every row says that name, `select name from user_names` lists it exactly once
- [ ] Reloading keeps user on homepage — no second login screen
- [ ] Signing out in one browser does not sign out the other
- [ ] `sqlite3 data/atm.db "select event_type,user_name,local_time from activity_log"` shows one `login` per login, one `logout` per sign-out, in time order, **no** row for refused attempt
- [ ] 2-letter name refused with readable message, no log row
- [ ] Restarting server sends every browser back to login on next request with `Session ended` banner; balance and names survive; same name can be used again
- [ ] `npm test` passes