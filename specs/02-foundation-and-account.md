# 02 — Foundation, Shared Account and Activity Logger

**Depends on:** `01`.
**Delivers:** a Node/Express/TypeScript server that serves a page, exposes
`GET /api/account`, owns the single account row seeded with `$1,000.00`, and records
and reads log entries. Restarting the process keeps the balance.
**Covers:** `specs.txt` §4, §9 (log storage), §12, §13 D, §13 E.

---

## 1. Done when

1. `npm install && npm run build && npm start` serves `http://localhost:3000/`.
2. The startup banner prints `ATM running on http://localhost:3000` plus one line per
   LAN URL, so the demo needs no IP hunting.
3. The account exists exactly once, seeded at `$1,000.00` when the database is created
   and never re-seeded.
4. The log is append-only and readable, with server-local timestamps and a pre-rendered
   `message` per entry.
5. Every response and error shape matches `01` §6.

Files (see `01` §2 for the layout): `package.json`, `tsconfig.json`, `.gitignore`,
`src/shared/types.ts`, `src/server/{config,money,time,db,activity,account}.ts`,
`src/server/http/errors.ts`, `src/server/http/routes/account.ts`,
`src/server/app.ts`, `src/server/index.ts`, `public/index.html`,
`public/css/atm.css` (empty stub with a one-line comment), and their tests.
`tsconfig.client.json` and `src/client/` arrive with slice 03 — `tsc` on an empty
client project is a hard error, so this slice builds the server only.

## 2. Build

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server/index.js",
    "dev": "npm run build && node --watch dist/server/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

`tsconfig.json`: `target ES2022`, `module commonjs`, `strict`, `outDir dist`,
`rootDir src`, `include: ["src/server/**/*.ts", "src/shared/**/*.ts"]`.
Slice 03 makes `build` run both configs.

## 3. Modules

`config.ts` exports the constants of `01` §3 with the documented defaults.

`money.ts`, `time.ts` — as specified in `01` §4 and §5. Extra rules:
`formatAUD(0)` is `"$0.00"`; negative input throws. `digitsToCents` throws on anything
that is not `^\d{1,7}$`. `isValidAmount` is that pattern **and** greater than zero; it
knows nothing about balance or deposit limits.

Tests pin `formatAUD(100000) === "$1,000.00"`, `formatAUD(1) === "$0.01"`,
`digitsToCents("500") === 50000`, `isValidAmount("0") === false`,
`isValidAmount("12345678") === false`, and the `12:30:45` / `2026-11-15` stamp shape.

`db.ts`:

1. Create the parent directory unless the path is `:memory:`.
2. Open with `better-sqlite3`; `journal_mode = WAL` (skipped for `:memory:`),
   `foreign_keys = ON`.
3. Run `SCHEMA_SQL` (`account`, `activity_log`, `user_names`), then
   `PRAGMA user_version = 1`.
4. If `SELECT COUNT(*) FROM account` is `0`, insert
   `(1, INITIAL_BALANCE_CENTS, Date.now())` in one transaction.

The seed is a one-time insert. Tests pin: a fresh `:memory:` database has one row with
`100000` and an empty `user_names`; write a change, close, reopen, and the balance
survives; opening an existing file does not throw.

`db.ts` also holds the module-level handle for the running server. Tests never share
it: every test creates its own database and passes it in, which is why `account.ts` and
`activity.ts` take the database as their first argument and the route layer supplies
the singleton.

`activity.ts`:

- `recordEvent` stamps the event with `localStamp()` **inside** the insert (never a
  caller-supplied timestamp), inserts the row, and returns `toPublicEntry`.
- `toPublicEntry` renders `message` exactly as `01` §6.2 specifies. It is pure and
  unit tested for all seven event types.
- `listEntries` builds a parameterised `WHERE` from the filter, orders by
  `timestamp_ms ASC, id ASC`, and applies `limit` (default 50, clamped to 1..200).
  Never interpolate a value into the SQL string.

Tests pin: chronological order for rows inserted out of order; the limit clamp;
`eventType` and `userName` filters; zero rows returns `[]`.

`account.ts` — this slice only needs `getAccount`: read the single row and return
`{ balanceCents, balanceFormatted, updatedAtMs }`, formatting with `formatAUD`. A
missing row throws `ApiError(500, "INTERNAL", "Account is missing.")` — it means the
seed failed. `withdraw` and `deposit` arrive in slice 06.

## 4. HTTP layer

- `errors.ts`: `class ApiError extends Error { status: number; code: string }` and
  `errorHandler` producing the `01` §6.1 shape. Unknown errors become 500 `INTERNAL`
  and are logged with their stack.
- `app.ts`: `createApp(deps: { db })` mounts `express.json()`, the `/api` routes,
  `express.static("public")` and the error handler last. It never calls `listen`.
- `index.ts`: opens the database from `config.DB_PATH`, creates app and HTTP server,
  listens on `HOST:PORT`, prints the banner, and exits with a clear message on
  `EADDRINUSE`.
- `routes/account.ts`: `GET /api/account` → `{ account }`; `GET /api/health` →
  `{ ok: true }`. Neither needs a session yet; slice 04 puts every real route behind
  `requireSession`.

## 5. `public/index.html`

`<meta name="viewport" content="width=device-width, initial-scale=1">`,
`<link rel="stylesheet" href="/css/atm.css">`, a `<main id="app">ATM</main>`, and no
script tag yet.

## 6. Acceptance criteria

- [ ] Clean clone: `npm install`, `npm run build`, `npm start` all succeed.
- [ ] `curl localhost:3000/api/health` → `{"ok":true}`.
- [ ] `curl localhost:3000/api/account` → `{"account":{"balanceCents":100000,"balanceFormatted":"$1,000.00",…}}`.
- [ ] The banner lists the machine's LAN IP and the port.
- [ ] `/` shows the placeholder page; `/css/atm.css` loads.
- [ ] `npm test` passes, including the reopen-and-reread persistence test.
- [ ] Deleting `data/atm.db` re-seeds `$1,000.00`; restarting without deleting leaves the
      balance untouched.
- [ ] No route returns a stack trace or a non-`01` error shape.
