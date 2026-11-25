# ATM

A shared-balance ATM for a LAN demo. Everyone sees the same account: you log in with
a name typed on the on-screen keypad, and the homepage shows the current balance.
Balance changes are pushed over Socket.IO, so every open browser updates without a
reload, and a small dot in the frame shows whether the connection is live.

## Implemented so far

Slices 01–05 of the specification are done:

- **01** — core contracts: money in integer cents, SQLite storage, HTTP error shape.
- **02** — database, account and activity log.
- **03** — single-page client shell: frame, display, keypad, state reducer.
- **04** — sessions: name login (multi-tap keypad), session cookie, sign-out,
  name availability, and sessions that expire after their last socket goes away.
- **05** — realtime: Socket.IO broadcasts for balance, activity and lock state,
  a reconnect re-fetch so a browser repairs its own state, and the connection dot.

Later slices (transactions, locks, AI assistant, …) are **not** implemented yet.

## Tech stack

Node.js, Express 4, TypeScript (`strict`), Socket.IO 4, `better-sqlite3`, Vitest with
Supertest, and a vanilla TypeScript client built as native ES modules (no bundler).

## Run it

```bash
npm install
npm run build
npm start
```

The server prints the local URL and every LAN URL it is reachable on. Open the app in
two browsers to see the realtime updates.

## Test it

```bash
npm test
```

## Notes

- The database lives at `data/atm.db` and is created and seeded on first start.
- Environment variables: `PORT` (default `3000`), `HOST` (default `0.0.0.0`),
  `DB_PATH` (default `data/atm.db`), `INITIAL_BALANCE_CENTS` (default `100000`), and
  `SESSION_GRACE_MS` (default `60000`).
- `data/`, `dist/` and `public/js/` are generated and not committed.
