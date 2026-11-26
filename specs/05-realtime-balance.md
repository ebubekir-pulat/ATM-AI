# 05 — Real-Time Balance and Lock Broadcasts

**Depends on:** `02`, `04`.
**Delivers:** Socket.IO wired end to end. A balance change in one browser appears in
every other browser without a reload, with a visible connection state.
**Covers:** `specs.txt` §5 ("view the balance even when another user is transacting"),
§13 A, and the transport half of §12.

---

## 1. Rules

1. Every connected browser sees `account:updated` within a second of a write made
   **through the server**. A write made out-of-band by another process (e.g. `sqlite3`
   or a separate `node` script) is not observed; the client repairs itself on the next
   reconnect or reload.
2. No client computes a balance; it displays what it was sent.
3. A reconnecting browser repairs its own state, even if it missed events.
4. An event is only ever sent **after** the database write committed.
5. Not-logged-in browsers receive events and ignore them.
6. Nothing here writes state. The socket carries information only.

Files: create `src/server/realtime.ts`, `src/client/realtime.ts`; modify
`index.ts` (HTTP server, Socket.IO, graceful shutdown), `main.ts`, `state.ts`,
`atm.css` (status dot). Tests: `tests/server/realtime.test.ts`.

## 2. Server

Signatures in `01` §9.

- `attachRealtime` is called once from `index.ts`. `app.ts` stays listen-free and
  socket-free so Supertest never starts a socket server by accident.
- On connection, resolve the session from the handshake cookie
  (`readSessionId(socket.handshake.headers.cookie)` → `getSession(id)`) and store
  `socket.data.sessionId` / `socket.data.userName` (both `null` when absent).
- Keep `Map<sessionId, Set<socketId>>` here and call
  `setSessionSockets(sessionId, set.size)` on every connection and disconnection. The
  last disconnection starts the `SESSION_GRACE_MS` countdown that ends the session and
  releases its lock; the name then becomes available to another session, while its
  `user_names` row stays. Slice 07 uses the same map to release a lock.
- Immediately after `connection`, send that socket the current `account:updated` and
  `lock:updated`, so the first paint needs no round trip. Until slice 07, `getLockState`
  is a local stub returning `{ locked: false, ownerName: null, isMine: false,
  expiresAtMs: null }`; slice 07 swaps in the real one and the loop below does not
  change.
- `broadcastAccount` sends `{ account }` and `broadcastActivity` sends `{ entry }` to
  every socket.
- `broadcastLockState()` takes no argument and reads the lock per socket, because
  `isMine` depends on the receiver:

```ts
for (const socket of io.sockets.sockets.values()) {
  socket.emit("lock:updated", { lock: getLockState(socket.data.sessionId) });
}
```

This is the only per-socket send in the system. The lock is held by a *session*, so
`isMine` comes from the session id, not from comparing `ownerName`.
- No `socket.on(...)` handlers except the `disconnect` hook added by slice 07; clients
  send no commands.
- Graceful shutdown on `SIGINT`/`SIGTERM`: close the socket server, the HTTP server and
  the database. A LAN demo is stopped with Ctrl-C all the time.

## 3. Client

```ts
// src/client/realtime.ts — thin adapter: parses nothing, keeps no state
export function connectRealtime(handlers: {
  onAccount: (account: Account) => void;
  onLock: (lock: LockState) => void;
  onActivity: (entry: ActivityEntry) => void;
  onStatus: (status: "connected" | "connecting" | "offline") => void;
}): void;
export function refreshSession(): void; // drop and re-open the socket
```

- Uses the global `io` from `/socket.io/socket.io.js` (type-only import from
  `socket.io-client`). Same origin, so the cookie is sent automatically. Only option:
  `reconnectionDelayMax: 3000`.
- `connect` → `onStatus("connected")`, then re-fetch `getAccount()` and push it through
  `onAccount`. Slice 07 adds `getLock()` to the same handler.
- `disconnect` → `onStatus("connecting")` while Socket.IO retries; `reconnect_failed`
  and a failed `connect_error` → `onStatus("offline")`.
- `refreshSession` is `socket.disconnect(); socket.connect();` — the socket reads the
  cookie **only during the handshake**, so `main.ts` calls it after a successful login
  and after sign-out. Without it, a browser that signed out and back in would keep the
  old `sessionId` and see `isMine: false` on its own lock.

`main.ts` calls `connectRealtime` once, after the slice 04 boot sequence:

- `onAccount` → `state.balanceCents = account.balanceCents`, re-render on `home` or
  `amount`; on `login` store it for later.
- `onLock` → `state.lock = lock`, re-render.
- `onActivity` → keep the last 20 entries in `state.recentActivity`; nothing visible yet.
- `onStatus` → `state.connection = status`.

Connection dot in the frame's header strip: `10px` circle plus `Live` (green),
`Reconnecting…` (amber), `Offline` (red), with `role="status"` and `aria-live="polite"`.
It is decorative, but it is the fastest way to notice a phone dropped off the Wi-Fi.

A balance that arrives while the page is on `login` is stored and used as soon as
`home` renders, so a user who logs in during someone else's transaction sees a current
balance.

## 4. Ordering guarantees

- Every broadcast is called from a route handler **after** its `db.transaction()`
  returned, so no client can observe an unstored balance.
- Socket.IO preserves per-socket order, so two writes produce two broadcasts in order
  and the last value wins.
- Because every event carries the full current value rather than a delta, a client that
  missed one is repaired by the `connect` re-fetch. No replay needed.

## 5. Tests

`tests/server/realtime.test.ts` starts a real server on port `0`:

1. Socket with no cookie → `account:updated` with the seeded balance and
   `lock.ownerName === null`.
2. `POST /api/session` → the socket gets `activity:created` with
   `eventType: "login"` and that `userName`.
3. `UPDATE account SET balance_cents = ?` then `broadcastAccount(getAccount(db))` → the
   socket gets the new value.
4. Two sockets, `SIMON` logged in, `broadcastLockState()` with a lock held by `SIMON` →
   the logged-in socket gets `isMine: true`, the anonymous one `isMine: false` and
   `ownerName: "SIMON"`.
5. Malformed cookie (`atm_sid=not-a-session`) → connection succeeds with `isMine: false`.
6. Server close → client gets `disconnect` (pass `reconnection: false`).
7. A logged-in socket keeps its session live (`GET /api/session` → 200); after the last
   socket closes and the session is swept past `SESSION_GRACE_MS`, the same cookie is
   401 — the link between presence and session lifetime.

Every test closes its sockets and server in `afterEach` so Vitest exits.

## 6. Acceptance criteria

- [ ] Two browsers are open on the homepage; when the balance changes through the server
      (a deposit or withdrawal from slice 06/07, or the realtime test's
      `broadcastAccount` call), the other browser updates without a reload. A direct
      `UPDATE account SET balance_cents = 250000 WHERE id = 1` from another process
      bypasses the server: it is not broadcast and appears only on reload, reconnect, or
      restart.
- [ ] If the server is stopped, both browsers show the amber "Reconnecting…" dot, then the
      red "Offline" dot; when it starts again they show green "Live" and get the balance.
- [ ] A sleeping device re-syncs within about three seconds of waking up.
- [ ] A login or sign-out sends an `activity:created` event to the other browser's socket.
- [ ] No route handler broadcasts before the database write has committed.
- [ ] `npm test` passes and exits without open handles.
