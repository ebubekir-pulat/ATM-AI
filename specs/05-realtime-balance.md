# 05 — Real-Time Balance and Lock Broadcasts

**Depends on:** `02`, `04`.
**Delivers:** Socket.IO wired end to end. A balance change made in one browser
appears in every other browser without a reload, with a visible connection state.
**Covers:** `specs.txt` §5 ("view the balance even when another user is
transacting"), §13 A (real-time updates), and the transport half of §12.

---

## 1. Rules this slice must satisfy

1. Every connected browser sees `account:updated` within a second of the change.
2. No client ever computes a balance; it only displays the one it was sent.
3. A browser that reconnects repairs its own state, even if it missed events.
4. An event is only ever sent **after** the database write committed.
5. Browsers that are not logged in receive events too, but ignore them. They are
   not an error path; the page may be sitting on the login screen.
6. Nothing here writes any state. The socket carries information only.

## 2. Files

Create: `src/server/realtime.ts`, `src/client/realtime.ts`.
Modify: `src/server/index.ts` (create an `http.Server`, attach Socket.IO,
graceful shutdown), `src/server/app.ts` (no change to routes), `src/client/main.ts`
(socket boot and handlers), `src/client/state.ts` (connection status),
`public/css/atm.css` (status dot). Tests: `tests/server/realtime.test.ts`.

## 3. Server

```ts
export function attachRealtime(server: http.Server, deps: { db: Database }): SocketIOServer;
export function broadcastAccount(account: Account): void;
export function broadcastActivity(entry: ActivityEntry): void;
export function broadcastLockState(): void;   // recomputed per socket
export function getIo(): SocketIOServer | null; // for tests and slice 07
```

- `attachRealtime` is called once, from `index.ts`. `app.ts` stays listen-free and
  socket-free so Supertest tests never start a socket server by accident.
- On connection, resolve the session from the handshake cookie:
  `readSessionId(socket.handshake.headers.cookie)` → `getSession(id)`, and store
  `socket.data.sessionId` and `socket.data.userName` (both `null` when absent).
- Immediately after `connection`, send that socket the current `account:updated`
  and `lock:updated` payloads, so the first paint does not need a round trip.
  Slice 07 owns the lock payload; until then emit
  `{ lock: { locked: false, ownerName: null, isMine: false, expiresAtMs: null } }`.
- `broadcastAccount` sends `{ account }` to every socket.
- `broadcastActivity` sends `{ entry }` to every socket.
- `broadcastLockState` sends `{ lock }` per socket, because `isMine` depends on
  **who is receiving it**:

```ts
for (const socket of io.sockets.sockets.values()) {
  socket.emit("lock:updated", { lock: getLockState(socket.data.sessionId) });
}
```

Until slice 07, `getLockState` is a local stub that always returns
`{ locked: false, ownerName: null, isMine: false, expiresAtMs: null }`; slice 07
replaces it with the real one from `lock.ts`, and this loop does not change.

This is the only per-socket send in the system. Names are not unique, so the
client cannot work out `isMine` from `ownerName` alone; the server decides.

- No `socket.on(...)` handlers except the `disconnect` hook added by slice 07.
  Clients do not send commands over the socket.
- Graceful shutdown on `SIGINT`/`SIGTERM`: close the socket server, close the HTTP
  server, close the database. A LAN demo is stopped with Ctrl-C all the time.

## 4. Client

`src/client/realtime.ts`:

```ts
export function connectRealtime(handlers: {
  onAccount: (account: Account) => void;
  onLock: (lock: LockState) => void;
  onActivity: (entry: ActivityEntry) => void;
  onStatus: (status: "connected" | "connecting" | "offline") => void;
}): void;
```

- Uses the global `io` from `/socket.io/socket.io.js` (type-only import from
  `socket.io-client`). Same origin, so the cookie is sent automatically.
- No options except `reconnectionDelayMax: 3000` — a slow reconnect makes the demo
  look broken.
- `connect` → `onStatus("connected")`, then re-fetch `getAccount()` and push it
  through `onAccount`. Slice 07 adds `getLock()` to the same handler, once the
  endpoint exists.
- `disconnect` → `onStatus("connecting")` while Socket.IO keeps trying;
  `reconnect_failed` and `connect_error` after the first attempt →
  `onStatus("offline")`.
- The module is a thin adapter: it parses nothing and keeps no state.

`main.ts`:

- Call `connectRealtime` once, after the boot sequence in slice 04.
- `onAccount` → `state.balanceCents = account.balanceCents`, re-render. Only when
  `screen` is `home` or `amount`; on `login` the value is stored for later.
- `onLock` → `state.lock = lock`, re-render.
- `onActivity` → keep the last 20 entries in `state.recentActivity` (slice 08 uses
  them); nothing visible yet.
- `onStatus` → `state.connection = status`.

The connection dot sits in the ATM frame's header strip: a `10px` circle plus text
`Live` (green), `Reconnecting…` (amber), `Offline` (red). It is decorative for the
demo but it is the fastest way to notice that a phone has dropped off the Wi-Fi.
It has `role="status"` and `aria-live="polite"`.

If the page is on the login screen when an `account:updated` arrives, nothing is
drawn; the value is used as soon as `home` renders, so a user who logs in during
another user's transaction still sees a current balance.

## 5. Ordering guarantees

- Every broadcast is called from a route handler **after** its `db.transaction()`
  returned, so no client can observe a balance that is not yet stored.
- Two writes in a row may produce two broadcasts in order; Socket.IO preserves
  per-socket order, so the last value wins on the client as it should.
- A client that missed a broadcast (asleep phone, closed lid) is repaired by the
  `connect` handler's re-fetch. No event log replay is needed, because every event
  carries the full current value rather than a delta.

## 6. Tests

`tests/server/realtime.test.ts` starts a real server on port `0`:

1. Connect a `socket.io-client` with no cookie → receives `account:updated` with
   the seeded balance and `lock.ownerName === null`.
2. `POST /api/session` for a valid name → the connected socket receives
   `activity:created` with `eventType: "login"` and the same `userName`.
3. Change the balance directly (`db.prepare("UPDATE account SET balance_cents = ?")`)
   and call `broadcastAccount(getAccount(db))` → the socket receives
   `account:updated` with the new value.
4. Two sockets, one logged in as `USER1`: `broadcastLockState()` with a lock held
   by `USER1` → the logged-in socket gets `isMine: true`, the anonymous socket gets
   `isMine: false` and `ownerName: "USER1"`.
5. Malformed cookie (`atm_sid=not-a-session`) → connection succeeds, payloads have
   `isMine: false`. A bad cookie must not break the realtime feed.
6. Server close → client receives `disconnect` (no reconnection in the test; pass
   `reconnection: false`).

All tests close their sockets and server in `afterEach` so Vitest exits.

## 7. Acceptance criteria

- [ ] Two browsers on the homepage. Change the balance in the database by hand
      (`UPDATE account SET balance_cents = 250000 WHERE id = 1`, then restart or
      trigger any transaction later) — the other browser updates without a reload.
- [ ] Killing the server turns both dots amber, then red; starting it again turns
      them green and the balance re-syncs.
- [ ] A phone that sleeps and wakes re-syncs on its own within three seconds.
- [ ] Logging in and signing out produces `activity:created` on the other browser's
      socket (verified in the console during development).
- [ ] No route handler broadcasts before its transaction commits.
- [ ] `npm test` passes, and `npm test` exits without open handles.

## 8. Refinement to `01`

`01` §9 originally left `broadcastLock` per-socket shape open. This slice fixes it:

```ts
export function broadcastLockState(): void;  // no argument; reads the lock itself
```

The lock state is read fresh for each socket, so a caller cannot broadcast a stale
`isMine`. Slice 07 relies on this signature.
