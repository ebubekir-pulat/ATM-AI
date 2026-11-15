# 02 — Foundation, Shared Account and Activity Logger

**Depends on:** `01-contracts.md`.
**Delivers:** a Node/Express/TypeScript server that serves a page, exposes
`GET /api/account`, owns the single account row seeded with `$1,000.00`, and can
record and read activity log entries. Restarting the process keeps the balance.
**Covers:** `specs.txt` §4 (shared account), §9 (log storage), §12, §13 D, §13 E.

---

## 1. What this slice must produce

1. `npm install && npm run build && npm start` serves `http://localhost:3000/`.
2. The startup banner prints the LAN URLs ("open on your phone: http://192.168.x.x:3000")
   so the demo can be run without hunting for the IP.
3. The account exists exactly once, seeded at `$1,000.00` when the database is
   created, and never re-seeded afterwards.
4. The log is append-only and readable, with server-local timestamps and a
   pre-rendered `message` per entry.
5. Every response shape and error shape matches `01-contracts.md` §6.

## 2. Files

Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/shared/types.ts`,
`src/server/config.ts`, `src/server/money.ts`, `src/server/time.ts`,
`src/server/db.ts`, `src/server/activity.ts`, `src/server/account.ts`,
`src/server/http/errors.ts`, `src/server/http/routes/account.ts`,
`src/server/app.ts`, `src/server/index.ts`, `public/index.html`,
`public/css/atm.css`, plus tests `tests/server/money.test.ts`,
`tests/server/time.test.ts`, `tests/server/db.test.ts`,
`tests/server/activity.test.ts`, `tests/server/account.test.ts`,
`tests/server/app.test.ts`.

`tsconfig.client.json` and `src/client/` arrive with slice 03. This slice builds the
server only.

## 3. Scripts and builds

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

- `tsconfig.json`: `target ES2022`, `module commonjs`, `strict`, `outDir dist`,
  `rootDir src`, `include: ["src/server/**/*.ts", "src/shared/**/*.ts"]`.
- `src/shared/types.ts` arrives with this slice: the `Account`, `ActivityEntry`,
  `Session` and `LockState` types from `01` §6.2, types only, no functions.
- `public/css/atm.css` starts as an empty file with a one-line comment; slice 03
  fills it in.
- `.gitignore` contains `node_modules/`, `dist/`, `data/`, `public/js/`, `*.log`.

Slice 03 adds the client build: `tsconfig.client.json`, `src/client/`, and
`"build": "tsc -p tsconfig.json && tsc -p tsconfig.client.json"`. It is split that
way so `tsc` never runs on an empty client project (which is a hard error, not a
warning).

## 4. `config.ts`

Exports the constants from `01-contracts.md` §3, reading env vars with the
documented defaults. It also exports `LAN_URLS: string[]`, computed from
`os.networkInterfaces()` (every non-internal IPv4 address) at startup, for the
banner only.

## 5. `money.ts`

```ts
export function formatAUD(cents: number): string;       // 100000 -> "$1,000.00"
export function digitsToCents(digits: string): number;  // "500" -> 50000
export function isValidAmount(digits: string): boolean;
```

- `formatAUD(0)` → `"$0.00"`; negative input is a programming error and throws.
- `digitsToCents` throws on anything that is not `^\d{1,7}$`.
- `isValidAmount` is `^\d{1,7}$` **and** the value is greater than zero.
  It does not know about balance or deposit limits; those live in `account.ts`.

Tests pin: `formatAUD(100000) === "$1,000.00"`, `formatAUD(1) === "$0.01"`,
`digitsToCents("500") === 50000`, `isValidAmount("0") === false`,
`isValidAmount("12345678") === false`.

## 6. `time.ts`

```ts
export function localStamp(now?: number): { timestampMs: number; localDate: string; localTime: string };
export function formatLocalDateTime(timestampMs: number): string;
```

- 24-hour clock, zero padded: `12:30:45`; date `2026-11-15`.
- Built with `Intl.DateTimeFormat("en-AU", { hour12: false, ... })` and **no
  `timeZone` option**, so the server's local zone wins.
- Tests pin the shape with a regex and pin that the date and time match the
  server's `Date` for a fixed instant, computed the same way in the test.

## 7. `db.ts`

```ts
export function openDatabase(path: string): Database.Database;
```

1. Create the parent directory when the path is not `:memory:`.
2. Open with `better-sqlite3`, set `journal_mode = WAL` (skipped for `:memory:`)
   and `foreign_keys = ON`.
3. Run the `SCHEMA_SQL` from `01` §8, then `PRAGMA user_version = 1`.
4. If `SELECT COUNT(*) FROM account` is `0`, insert
   `(1, INITIAL_BALANCE_CENTS, Date.now())` inside one transaction.

Seeding is a one-time insert, so a restart keeps the existing balance. Tests pin:

- a fresh `:memory:` database has one account row with `100000`;
- calling `openDatabase` twice on the same file keeps whatever balance exists
  (write a change, close, reopen, read);
- the schema is idempotent (opening an existing file does not throw).

`db.ts` is also where the module-level `db` handle lives for the running server.
Tests must not share it: every test creates its own database through
`openDatabase(":memory:")` and passes it in. To keep that possible, `account.ts`
and `activity.ts` take the database as their first argument where they are called
from routes, and the route layer supplies the singleton. Signature therefore:

```ts
export function getAccount(db: Database.Database): Account;
export function recordEvent(db: Database.Database, input: RecordEventInput): ActivityEntry;
export function listEntries(db: Database.Database, filter?: EntryFilter): ActivityEntry[];
```

This is the one refinement this slice makes to `01` §9; `01` already declares the
shape of the return values.

## 8. `activity.ts`

```ts
export interface RecordEventInput {
  eventType: ActivityEntry["eventType"];
  userName: string;
  amountCents?: number | null;
  balanceAfterCents?: number | null;
  reason?: string | null;
}
```

`recordEvent` stamps the event with `localStamp()` **inside** the insert (never a
timestamp supplied by the caller), inserts the row, and returns the
`ActivityEntry` built by `toPublicEntry`.

`toPublicEntry` renders `message` exactly as `01` §6.2 specifies. It is a pure
function of the row and is unit tested for all seven event types, including the
two `*_failed` messages with their reason text and the `$` formatting.

`listEntries` builds a parameterised `WHERE` from the filter, orders by
`timestamp_ms ASC, id ASC`, and applies `limit` (default 50, clamped to 1..200).
It must never interpolate a value into the SQL string.

Tests pin: chronological order for events inserted out of order; `limit` clamp;
`eventType` and `userName` filters; zero rows returns `[]`.

## 9. `account.ts`

```ts
export function getAccount(db: Database.Database): Account;
```

Reads the single row and returns `{ balanceCents, balanceFormatted, updatedAtMs }`.
`balanceFormatted` comes from `formatAUD`. If the row is missing, throw
`ApiError(500, "INTERNAL", "Account is missing.")` — that means the seed failed.

`withdraw` and `deposit` are slice 06. Their validation and atomicity belong with
the transaction endpoints, not here.

## 10. HTTP layer

- `errors.ts`: `class ApiError extends Error { status: number; code: string }` and
  `errorHandler(err, req, res, next)` producing the `01` §6.1 shape. Unknown
  errors become 500 `INTERNAL` and are logged with their stack.
- `app.ts`: `createApp(deps: { db })` returns the Express app. It mounts
  `express.json()`, the `/api` routes, `express.static("public")`, and the error
  handler last. It does **not** call `listen`.
- `index.ts`: opens the database from `config.DB_PATH`, creates the app, creates
  the HTTP server, starts listening on `HOST:PORT`, prints the banner
  (`ATM running on http://localhost:3000` plus one line per LAN URL), and exits
  with a clear message if the port is taken (`EADDRINUSE`).
- `routes/account.ts`: `GET /api/account` → `{ account }`; `GET /api/health` →
  `{ ok: true }`.
- `routes/account.ts` needs no session in this slice; slice 04 puts every real
  route behind `requireSession`.

## 11. `public/index.html`

A minimal, valid page:

- `<meta name="viewport" content="width=device-width, initial-scale=1">`
- `<link rel="stylesheet" href="/css/atm.css">`
- a `<main id="app">` containing the text `ATM` (slice 03 replaces the contents)
- no script tag yet

## 12. Acceptance criteria

- [ ] `npm install`, `npm run build`, `npm start` succeed from a clean clone.
- [ ] `curl localhost:3000/api/health` → `{"ok":true}`.
- [ ] `curl localhost:3000/api/account` → `{"account":{"balanceCents":100000,"balanceFormatted":"$1,000.00",...}}`.
- [ ] The banner lists the machine's LAN IP and the port.
- [ ] `http://localhost:3000/` shows the placeholder page; `/css/atm.css` loads.
- [ ] `npm test` passes, including the reopen-and-reread persistence test.
- [ ] Deleting `data/atm.db` and restarting re-seeds `$1,000.00`; restarting
      without deleting leaves the balance untouched.
- [ ] No route returns a stack trace or a non-`01` error shape.
- [ ] `src/client/` and `tsconfig.client.json` do not exist yet; the server build is
      the whole build.
