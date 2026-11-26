# Real-Time Balance and Lock Broadcasts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Socket.IO end to end so a balance change in one browser appears in every other browser without a reload, with a visible connection state.

**Depends on:** Slices 02, 04 (per spec — slice 03 is not a dependency)

**Spec:** `specs/05-realtime-balance.md` (signature contracts in `specs/01-contracts.md` §9)

## Global Constraints

- Every connected browser sees `account:updated` within a second of a committed write.
- No client computes a balance; it displays what it was sent. Events carry the full value, not a delta.
- An event is only ever sent after the DB write committed — broadcasts happen after `db.transaction()` returns.
- A reconnecting browser repairs its own state via the post-connect re-fetch; no replay needed.
- Not-logged-in browsers receive events and ignore them.
- Nothing here writes state; the socket carries information only.

- Server: CommonJS, client: ES modules, `strict: true`, no `any` / `@ts-ignore` in `src/`. No `vitest.config.ts` (default globs). Express 4: route handlers are synchronous, only sync throws reach the error handler.

## Review Focus

1. Broadcast before commit — ordering with the DB transaction.
2. Per-socket lock state — `isMine` comes from the session id, not from comparing `ownerName`.
3. Presence → grace sweep — `setSessionSockets` on connect/disconnect; last disconnect starts the sweep countdown.
4. Client status transitions — `connecting` → `connected` → `offline`.
5. Anonymous sockets — receive events, ignore them.

---

## Task 1: Server — Realtime Module and Wiring

**Files:**
- Create: `src/server/realtime.ts`
- Create: `tests/server/realtime.test.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/http/routes/session.ts` (to broadcast login/logout activity)

**Interfaces:**
- Consumes: `attachRealtime(server, deps: { db })`, `broadcastAccount(account)`, `broadcastActivity(entry)`, `broadcastLockState()`, `getLockState(sessionId)`, `getIo()` — contracts in `specs/01-contracts.md` §9.
- Consumes: `readSessionId`, `getSession`, `setSessionSockets` — from `src/server/sessions.ts`.
- Produces: the same six realtime functions in `src/server/realtime.ts`.

### Step 1: Add dependencies

```bash
npm install socket.io socket.io-client
```

### Step 2: Write the failing tests

Create `tests/server/realtime.test.ts` — real server on port `0`, real socket.io-client, close everything in `afterEach`:

1. No cookie → `account:updated` with the seeded balance, `lock.ownerName === null`.
2. `POST /api/session` → socket gets `activity:created` with `eventType: "login"` and that `userName`.
3. `UPDATE account SET balance_cents = ?` then `broadcastAccount(getAccount(db))` → socket gets the new value.
4. Two sockets, `SIMON` logged in, lock held by `SIMON` → logged-in socket gets `isMine: true`; anonymous one gets `isMine: false` and `ownerName: "SIMON"`.
5. Malformed cookie (`atm_sid=not-a-session`) → connection succeeds with `isMine: false`.
6. Server close → client gets `disconnect` (client `reconnection: false`).
7. Logged-in socket keeps session live (`GET /api/session` → 200); after last socket closes and session is swept past `SESSION_GRACE_MS`, the same cookie → 401.

Run: `npx vitest run tests/server/realtime.test.ts`
Expected: FAIL — `src/server/realtime.ts` not found.

### Step 3: Implement `src/server/realtime.ts`

- `attachRealtime(server, deps)`: create the Socket.IO `Server` attached to the http server (CORS open for the LAN demo), on `connection` resolve the session from the handshake cookie, store `socket.data.sessionId` / `socket.data.userName` (both `null` when absent), track `Map<sessionId, Set<socketId>>`, call `setSessionSockets(sessionId, set.size)` on connect and disconnect (disconnect → 0 → grace countdown starts).
- Right after connection: send the socket `account:updated` (current account) and `lock:updated`.
- `broadcastAccount(account)`: emit `account:updated` with `{ account }` to every socket.
- `broadcastActivity(entry)`: emit `activity:created` with `{ entry }` to every socket.
- `broadcastLockState()`: no argument; loop `io.sockets.sockets.values()` and emit `lock:updated` with `{ lock: getLockState(socket.data.sessionId) }` — the only per-socket send.
- `getLockState(sessionId)`: local stub returning `{ locked: false, ownerName: null, isMine: false, expiresAtMs: null }` (slice 07 replaces this with the real implementation).
- `getIo()`: returns the Socket.IO server instance or `null`.

**Decision:** `getLockState` is a local stand-in in `src/server/realtime.ts`; it moves into `src/server/lock.ts` in slice 07, which swaps the body and leaves the broadcast loop unchanged.

### Step 4: Wire `src/server/index.ts`

- `http.createServer(app)` + `attachRealtime(server, { db })` + `server.listen(PORT, HOST)`.
- Remove the no-op `broadcastActivity` function and its import from `createApp`.
- Graceful shutdown on `SIGINT`/`SIGTERM`: close socket server (`io.close()`), close HTTP server, close DB.

### Step 5: Update `src/server/http/routes/session.ts`

- After successful session creation (login), call `broadcastActivity(entry)` with the login activity entry.
- After successful session destruction (logout), call `broadcastActivity(entry)` with the logout activity entry.
- Import `broadcastActivity` from `src/server/realtime.ts`.

### Step 6: Run tests

Run: `npx vitest run tests/server/realtime.test.ts`
Expected: PASS

### Step 7: Commit

```bash
git add src/server/realtime.ts src/server/index.ts src/server/http/routes/session.ts tests/server/realtime.test.ts package.json package-lock.json
git commit -m "feat: wire Socket.IO realtime broadcasts and graceful shutdown"
```

---

## Task 2: Client — Realtime Adapter and Wiring

**Files:**
- Create: `src/client/realtime.ts`
- Modify: `src/client/main.ts`, `src/client/state.ts`, `src/client/api.ts`

**Interfaces:**
- Consumes: `connectRealtime(handlers)`, `refreshSession()` from `src/client/realtime.ts`; `getAccount()` from `src/client/api.ts`.
- Produces: realtime handler wiring in `src/client/main.ts`.

### Step 1: Implement `src/client/realtime.ts` (thin adapter: parses nothing, keeps no state)

- `connectRealtime(handlers: { onAccount; onLock; onActivity; onStatus })`:
  - `io({ reconnectionDelayMax: 3000 })`, same origin (cookie sent automatically).
  - `connect` → `onStatus("connected")` → re-fetch `getAccount()` → push through `onAccount`.
  - Failed `connect_error` or `reconnect_failed` → `onStatus("offline")`.
  - `disconnect` → `onStatus("connecting")` while retrying.
  - Listen: `account:updated` → `onAccount(payload.account)`; `lock:updated` → `onLock(payload.lock)`; `activity:created` → `onActivity(payload.entry)`.
- `refreshSession()`: `socket.disconnect(); socket.connect();`

### Step 2: Wire `src/client/main.ts`

- Call `connectRealtime` once after the slice 04 boot sequence (after `boot()` completes).
- `onAccount` → `dispatch({ type: "balance", balanceCents: account.balanceCents })`.
- `onLock` → dispatch lock action → `state.lock = lock`.
- `onActivity` → dispatch activity → keep last 20 entries in `state.recentActivity`.
- `onStatus` → `dispatch({ type: "connection", status })`.
- After successful login and after sign-out: `await refreshSession()` (already present in `main.ts`, just change the import source).

### Step 3: Update `src/client/state.ts`

- Use the shared `LockState` / `ActivityEntry` types from `src/shared/types.ts` (replace any local shapes).
- Add `lock` and `activity` reducer actions.
- Add `connection` state field and reducer action.

### Step 4: Remove the no-op

- Delete the no-op `refreshSession` from `src/client/api.ts`; main now imports `refreshSession` from `src/client/realtime.ts`.

### Step 5: Run tests

Run: `npm test` (runs full suite including existing client tests)
Expected: PASS

### Step 6: Commit

```bash
git add src/client/realtime.ts src/client/main.ts src/client/state.ts src/client/api.ts
git commit -m "feat: add client realtime adapter and wiring"
```

---

## Task 3: Connection Status Dot

**Files:** Modify `src/client/ui/display.ts`, `src/client/screens/home.ts`, `public/css/atm.css`

### Step 1: Render the status dot

- Home view carries the connection status; display renders a status strip: 10px dot + `Live` (green) / `Reconnecting…` (amber) / `Offline` (red), with `role="status"` and `aria-live="polite"`.
- The dot is shown in the frame's header strip (top of the home screen).

### Step 2: Style

- Add dot/label styles to `public/css/atm.css`.

### Step 3: Run tests and commit

Run: `npm test`
Expected: PASS

```bash
git add src/client/ui/display.ts src/client/screens/home.ts public/css/atm.css
git commit -m "feat: add connection status dot to home frame"
```

---

## Task 4: Build, Full Test Suite, Commit

### Step 1: Build

Run: `npm run build`
Expected: No errors; server to `dist/`, client to `public/js/`.

### Step 2: Full test suite

Run: `npm test`
Expected: All tests pass, no open handles.

### Step 3: Commit

```bash
git add -A
git commit -m "feat: complete slice 05 - realtime balance and lock broadcasts"
```

---

## Acceptance Criteria Checklist

- [ ] Two browsers open on the homepage; when the balance changes through the server
      (a deposit or withdrawal in slice 06/07, or the realtime test's `broadcastAccount`
      call), the other browser updates without a reload. A direct `UPDATE account ...`
      from another process is not observed; it appears only on reload, reconnect, or
      restart.
- [ ] If the server is stopped, both browsers show the amber "Reconnecting…" dot, then the red "Offline" dot; when it starts again they show green "Live" and get the balance.
- [ ] A sleeping device re-syncs within about three seconds of waking up.
- [ ] A login or sign-out sends an `activity:created` event to the other browser's socket.
- [ ] No route handler broadcasts before the database write has committed.
- [ ] `npm test` passes and exits without open handles.

---

## Manual Verification — Asserting the Acceptance Criteria

How an engineer manually asserts each acceptance criterion after implementing:

1. **Balance change propagates:** until slice 06/07 adds deposit and withdrawal, this is
   covered by `npx vitest run tests/server/realtime.test.ts` ("broadcasts a committed
   balance change"), which writes the row and calls `broadcastAccount`. After slice
   06/07, deposit in one browser and watch the other update without a reload. A direct
   `UPDATE account SET balance_cents = 250000 WHERE id = 1` against `data/atm.db` is
   out-of-band: it is not broadcast, and appears only after a reload, reconnect, or
   restart.
2. **Connection state:** stop the server; both browsers show amber "Reconnecting…" then red "Offline"; restart; both show green "Live" and get the balance.
3. **Sleeping device:** sleep a logged-in device; wake it; within ~3s it shows green "Live" and the current balance.
4. **Login / sign-out activity:** while one browser is connected, log in / sign out from the other; the connected browser receives `activity:created`.
5. **No broadcast before commit:** verify by code inspection that broadcasts are only called after the write transaction returns (becomes fully enforced with slice 06 transaction routes).
6. **Test suite:** run `npm test`; must pass and exit without open handles.

---

## README After Slice 05

There is no README in the project root yet. After this slice is implemented, write `README.md` covering the state of the project at that point:

- What the app is (shared-balance ATM, keypad login, homepage, realtime updates).
- What is implemented so far (slices 01–05 done; do not document later slices as done).
- Tech stack: Node.js, Express, TypeScript, Socket.IO, better-sqlite3, Vitest, vanilla JS client.
- How to run: `npm install`, `npm run build`, `npm start`.
- How to test: `npm test`.
- Notes: `data/atm.db`, env vars (`PORT`, `HOST`, `DB_PATH`, `INITIAL_BALANCE_CENTS`, `SESSION_GRACE_MS`).