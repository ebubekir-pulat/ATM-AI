# 01 — Contracts

**Depends on:** nothing.
**Delivers:** the one place where names, paths, types, endpoints, events and the
database schema are defined. Every later slice builds against this file.
**Covers:** `specs.txt` §4, §9 (storage), §12 (architecture), §13 D/E.

If a slice needs something that is not here, it is added here first.

---

## 1. Technology

Open source, installed with `npm`. Nothing else.

| Concern | Choice | Why |
|---------|--------|-----|
| Runtime | Node.js 20 LTS or newer | Required by the tooling below. |
| Language | TypeScript, `strict: true` | Server and client are the same language. |
| HTTP | Express 4 | Smallest thing that serves JSON and static files. |
| Realtime | Socket.IO 4 | Reconnect and room handling come for free. |
| Storage | SQLite via `better-sqlite3` | Synchronous API, so a check-and-update cannot interleave with another request; `db.transaction()` gives atomicity. |
| Frontend | HTML + CSS + TypeScript modules, no framework | The ATM is five screens and a keypad. |
| AI | Ollama, HTTP API `http://127.0.0.1:11434` | Local inference, no cloud, no API key. |
| Tests | Vitest + Supertest | TypeScript runs without a build step; Supertest drives Express in-process. |

**Commands over HTTP, events over WebSocket.** Anything that changes state is an
HTTP request that returns the new state. WebSocket is only used to *tell* the
other clients what changed. This keeps every rule in one place (the request
handler) and keeps clients from needing to agree on a protocol for actions.

## 2. Repository layout

```
package.json
tsconfig.json              server build  -> dist/
tsconfig.client.json       client build  -> public/js/
.gitignore                 must contain: node_modules/ dist/ data/ public/js/
data/atm.db                created at runtime, never committed
src/server/
  index.ts                 creates the app, listens on HOST:PORT
  app.ts                   express app + routes + static files (no listen, for tests)
  config.ts                every constant and env var in §3
  db.ts                    open, migrate, seed the account
  money.ts                 cents <-> dollars, formatAUD, parseDigits
  time.ts                  server-local date/time strings
  sessions.ts              in-memory session store
  lock.ts                  LockManager (slice 07)
  account.ts               getBalance, withdraw, deposit
  activity.ts              recordEvent, listEntries
  retrieval.ts             turns a question into log rows + computed totals
  ollama.ts                thin HTTP client for Ollama
  assistant.ts             answerQuestion (slice 08)
  realtime.ts              Socket.IO setup and broadcast helpers
  http/
    requireSession.ts      route middleware: 401 when no session
    errors.ts              ApiError + error middleware
    routes/account.ts      GET  /api/account
    routes/session.ts      POST/GET/DELETE /api/session
    routes/transactions.ts POST /api/transactions/withdraw|deposit
    routes/lock.ts         POST /api/lock, POST /api/lock/renew, DELETE /api/lock, GET /api/lock
    routes/activity.ts     GET  /api/activity
    routes/assistant.ts    POST /api/assistant/chat
src/shared/
  types.ts                 Account, ActivityEntry, LockState, Session — types only
src/client/
  main.ts                  bootstrap, socket wiring, screen switching
  state.ts                 the client's single state object
  api.ts                   typed fetch wrappers for the endpoints in §6
  screens/login.ts         name entry
  screens/home.ts          welcome, balance, buttons
  screens/amount.ts        withdraw / deposit amount entry
  screens/message.ts       result and error feedback
  ui/keypad.ts             the 15 buttons
  ui/display.ts            the screen area inside the ATM
  ui/multitap.ts           key presses -> text (pure, unit tested)
  ui/money.ts              formatAUD for display only (no arithmetic)
  ui/assistant.ts          floating button + chat panel
  realtime.ts              Socket.IO client adapter (slice 05)
public/
  index.html
  css/atm.css
  js/                      output of tsconfig.client.json (generated)
tests/
  server/*.test.ts         Vitest + Supertest
  client/*.test.ts         pure client logic (no DOM)
```

**Dependency direction:** `routes → account|activity|lock|assistant →
db|sessions|money|time`. Nothing imports upward. `assistant.ts` may import
`retrieval.ts`, `activity.ts` and `ollama.ts`, and **must not** import `account.ts`
or `lock.ts`. That import rule is how the read-only guarantee is enforced.

**Client imports** use explicit `.js` extensions (`import { x } from "./ui/keypad.js"`)
because the browser loads the compiled files as native ES modules. There is no
bundler.

**Type-only imports** from `socket.io-client` are allowed; the runtime client
comes from `/socket.io/socket.io.js`, loaded by `index.html` before `main.js`.

## 3. Configuration

`config.ts` reads the environment once and exports constants. Defaults are what
the LAN demo uses.

| Constant | Env var | Default | Meaning |
|----------|---------|---------|---------|
| `PORT` | `PORT` | `3000` | HTTP and WebSocket port. |
| `HOST` | `HOST` | `0.0.0.0` | Bind to every interface so phones can reach it. |
| `DB_PATH` | `DB_PATH` | `data/atm.db` | SQLite file; tests pass `:memory:`. |
| `INITIAL_BALANCE_CENTS` | `INITIAL_BALANCE_CENTS` | `100000` | $1,000.00, used once, when the database is created. |
| `MAX_DEPOSIT_CENTS` | — | `1000000` | $10,000.00 per deposit. |
| `MAX_AMOUNT_DIGITS` | — | `7` | Keypad buffer limit for amounts. |
| `MIN_NAME_LENGTH` | — | `3` | From the source spec. |
| `MAX_NAME_LENGTH` | — | `20` | UI buffer limit; not a source-spec rule. |
| `MULTITAP_WINDOW_MS` | — | `800` | Press window for cycling letters on one key. |
| `LOCK_LEASE_MS` | `LOCK_LEASE_MS` | `30000` | Lock expires this long after the last renewal. |
| `LOCK_RENEW_MS` | — | `10000` | Client renewal interval; one third of the lease. |
| `AI_CONTEXT_LIMIT` | — | `50` | Maximum log rows sent to the model. |
| `AI_TIMEOUT_MS` | — | `20000` | Ollama request timeout. |
| `OLLAMA_URL` | `OLLAMA_URL` | `http://127.0.0.1:11434` | Local inference server. |
| `OLLAMA_MODEL` | `OLLAMA_MODEL` | `llama3.2:3b` | Model name; any pulled model works. |
| `SESSION_COOKIE` | — | `atm_sid` | Session cookie name. |
| `SESSION_IDLE_MS` | — | `86400000` | Sessions with no request for 24 h are swept (slice 04). |

## 4. Money

All money on the wire and in the database is an **integer number of cents**,
named `...Cents`. No floats, ever.

```ts
// src/server/money.ts
export function formatAUD(cents: number): string;      // 100000 -> "$1,000.00"
export function digitsToCents(digits: string): number; // "500" -> 50000 (whole dollars)
export function isValidAmount(digits: string): boolean; // 1..MAX_AMOUNT_DIGITS digits, not "0"
```

- `formatAUD` uses `Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" })`.
- The keypad has no decimal point, so typed digits are **whole dollars**:
  `"500"` means $500.00. The client sends `amountCents: 50000`.
- The ATM shows the balance with cents (`$1,000.00`) always.

## 5. Time

```ts
// src/server/time.ts
export interface LocalStamp {
  timestampMs: number;  // Date.now()
  localDate: string;    // "2026-11-15"
  localTime: string;    // "12:30:45"
}
export function localStamp(now?: number): LocalStamp;
export function formatLocalDateTime(timestampMs: number): string; // "2026-11-15 12:30:45"
```

`localStamp` formats with `Intl.DateTimeFormat` and **no `timeZone` option**, so
it uses the server's timezone. It is called once, when the event happens, and the
two strings are stored on the row. Clients display the stored strings verbatim.

## 6. HTTP contract

Base path `/api`. JSON in, JSON out. The session cookie is the only credential.

### 6.1 Errors

Non-2xx responses are always:

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "That is more than the balance." } }
```

`message` is written for a person and is shown in the ATM display unchanged.

| HTTP | `code` | Raised when |
|------|--------|-------------|
| 400 | `INVALID_NAME` | Name shorter than 3, longer than 20, or not A–Z |
| 400 | `INVALID_AMOUNT` | Amount not 1–7 digits, zero, or not a whole number of dollars |
| 400 | `INSUFFICIENT_FUNDS` | Withdrawal greater than the balance |
| 400 | `AMOUNT_TOO_LARGE` | Deposit greater than `MAX_DEPOSIT_CENTS` |
| 401 | `NOT_AUTHENTICATED` | No valid session cookie |
| 400 | `INVALID_QUESTION` | Assistant message empty or longer than 500 characters |
| 409 | `LOCK_NOT_HELD` | Deposit/withdraw without holding the lock |
| 409 | `LOCK_LOST` | Lock renewal by a session that no longer owns it |
| 423 | `ACCOUNT_LOCKED` | Lock requested while another session owns it |
| 503 | `ASSISTANT_UNAVAILABLE` | Ollama unreachable or timed out |
| 500 | `INTERNAL` | Anything unexpected; details are logged, not returned |

### 6.2 Types

```ts
type Session = { userName: string };
type Account = { balanceCents: number; balanceFormatted: string; updatedAtMs: number };
type ActivityEntry = {
  id: number;
  eventType: "login" | "logout" | "withdraw" | "deposit"
           | "withdraw_failed" | "deposit_failed" | "transaction_cancelled";
  userName: string;
  amountCents: number | null;
  balanceAfterCents: number | null;
  reason: string | null;
  timestampMs: number;
  localDate: string;      // "2026-11-15"
  localTime: string;      // "12:30:45"
  message: string;        // "User3: Withdrew $5,000.00 at 12:30:55"
};
type LockState = {
  locked: boolean;
  ownerName: string | null;
  isMine: boolean;
  expiresAtMs: number | null;
};
```

`message` is built by the server from the event type and amount, so the ATM, the
log API and the AI all show identical wording:

| `eventType` | `message` |
|-------------|-----------|
| `login` | `User1: Logged in at 12:30:45` |
| `logout` | `User1: Logged out at 12:41:00` |
| `withdraw` | `User1: Withdrew $5,000.00 at 12:40:00` |
| `deposit` | `User1: Deposited $500.00 at 12:40:00` |
| `withdraw_failed` | `User1: Withdrawal of $5,000.00 failed (insufficient funds) at 12:40:00` |
| `deposit_failed` | `User1: Deposit of $12,000.00 failed (above the $10,000.00 limit) at 12:40:00` |
| `transaction_cancelled` | `User1: Cancelled a withdrawal at 12:40:00` |

### 6.3 Endpoints

All except `GET /api/health` and `POST /api/session` require a session.

| Method | Path | Request | Success |
|--------|------|---------|---------|
| GET | `/api/health` | — | `200 { "ok": true }` |
| POST | `/api/session` | `{ "name": "USER1" }` | `201 { "session": { "userName": "USER1" } }` + `Set-Cookie` |
| GET | `/api/session` | — | `200 { "session": { "userName": "USER1" } }` |
| DELETE | `/api/session` | — | `204`, cookie cleared, `logout` entry |
| GET | `/api/account` | — | `200 { "account": Account }` |
| GET | `/api/lock` | — | `200 { "lock": LockState }` |
| POST | `/api/lock` | — | `201 { "lock": LockState }`; `200` when the caller already owns it; `423 ACCOUNT_LOCKED` otherwise |
| POST | `/api/lock/renew` | — | `200 { "lock": LockState }` or `409 LOCK_LOST` |
| DELETE | `/api/lock` | `?cancelled=withdraw\|deposit` (optional) | `204`; idempotent; records `transaction_cancelled` when a lock was held |
| POST | `/api/transactions/withdraw` | `{ "amountCents": 50000 }` | `200 { "account": Account }` |
| POST | `/api/transactions/deposit` | `{ "amountCents": 50000 }` | `200 { "account": Account }` |
| GET | `/api/activity` | `?limit=50&eventType=&userName=&fromMs=&toMs=` | `200 { "entries": ActivityEntry[] }` |
| POST | `/api/assistant/chat` | `{ "message": "Who withdrew $5,000?" }` | `200 { "reply": string, "evidence": ActivityEntry[] }` |

Notes that hold for every endpoint:

- A failed deposit/withdraw still releases the lock and writes a
  `*_failed` entry before responding (see slice 07).
- `GET /api/activity` returns entries **oldest first**, default `limit=50`,
  maximum `200`.
- `POST /api/assistant/chat` returns at most `AI_CONTEXT_LIMIT` (50) entries in
  `evidence`, oldest first: exactly the rows given to the model.
- Amounts arrive as `amountCents`; the server rejects anything that is not a
  positive integer.

## 7. WebSocket contract

Socket.IO on the same HTTP server, so the browser connects to the page's own
origin. The session cookie is sent with the handshake; the server resolves it to
a session (or none) and keeps `socket.data.sessionId` / `socket.data.userName`.

The server broadcasts to **all** connected sockets. A socket that is not logged in
ignores the events; it is still sent them so that a freshly loaded page already
has the latest state.

| Event | Direction | Payload |
|-------|-----------|---------|
| `account:updated` | server → client | `{ account: Account }` |
| `lock:updated` | server → client | `{ lock: LockState }` |
| `activity:created` | server → client | `{ entry: ActivityEntry }` |

- Sent after the database write has committed, never before.
- `connect` on the client is followed by `GET /api/account` and `GET /api/lock`,
  so a reconnect repairs anything missed while offline.
- Clients send no WebSocket messages. All commands are HTTP.

## 8. Database

One file. `db.ts` opens it, sets `PRAGMA journal_mode = WAL` and
`PRAGMA foreign_keys = ON`, then applies `SCHEMA_SQL` (idempotent, `IF NOT EXISTS`)
and seeds the account when it is absent.

```sql
CREATE TABLE IF NOT EXISTS account (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type          TEXT    NOT NULL CHECK (event_type IN
                        ('login','logout','withdraw','deposit',
                         'withdraw_failed','deposit_failed','transaction_cancelled')),
  user_name           TEXT    NOT NULL,
  amount_cents        INTEGER,
  balance_after_cents INTEGER,
  reason              TEXT,
  timestamp_ms        INTEGER NOT NULL,
  local_date          TEXT    NOT NULL,
  local_time          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS activity_log_timestamp_idx ON activity_log (timestamp_ms);
```

Rules:

- `account.id` is always `1`. There is exactly one balance.
- `balance_cents` may never be negative; the `CHECK` is the last line of defence
  behind the application rule.
- `amount_cents` and `balance_after_cents` are `NULL` for `login` and `logout`.
- `reason` is one of `insufficient_funds`, `amount_too_large`, `invalid_amount`,
  `lock_conflict`, `cancelled`, or `NULL`.
- Indexes are declared in the schema string, not created ad hoc.

**Sessions, lock state and the AI chat are in memory only.** They describe who is
connected *now*; they are meaningless after a restart, and persisting them would
create stale locks. The balance and the log are the state that must survive, and
they live in SQLite.

## 9. Module contracts

Signatures the later slices depend on. Bodies belong to the slices.

```ts
// db.ts
export function openDatabase(path: string): Database.Database; // migrates + seeds

// account.ts   (`db` is passed in, so tests never share a handle)
export function getAccount(db: Database.Database): Account;
export function withdraw(db: Database.Database, userName: string, amountCents: number): TxResult;
export function deposit(db: Database.Database, userName: string, amountCents: number): TxResult;

// activity.ts
export function recordEvent(db: Database.Database, input: RecordEventInput): ActivityEntry;
export function listEntries(db: Database.Database, filter?: EntryFilter): ActivityEntry[];
export function toPublicEntry(row: ActivityRow): ActivityEntry; // builds `message`

// sessions.ts
export function createSession(userName: string): Session;
export function getSession(id: string | null): Session | null;
export function destroySession(id: string): void;
export function readSessionId(cookieHeader: string | undefined): string | null;
export function sweepIdleSessions(nowMs: number): Session[];

// lock.ts  (slice 07)
export function acquire(sessionId: string, userName: string, nowMs?: number): LockInfo;
export function renew(sessionId: string, nowMs?: number): LockInfo;
export function release(sessionId: string, opts?: { reason?: "cancelled" | "disconnect" | "done" }): boolean;
export function isLockOwner(sessionId: string | null): boolean;
export function getLock(): LockInfo | null;
export function getLockState(sessionId: string | null): LockState;
export function sweepExpired(nowMs?: number): boolean;
export function resetLock(): void; // tests only

// realtime.ts
export function attachRealtime(server: http.Server, deps: { db: Database }): io.Server;
export function broadcastAccount(account: Account): void;
export function broadcastActivity(entry: ActivityEntry): void;
export function broadcastLockState(): void;                // per-socket isMine, slice 05
export function getIo(): io.Server | null;
```

`TxResult` is defined by slice 06: `{ ok: true; account: Account; entry: ActivityEntry }`
or `{ ok: false; code: string; message: string; entry: ActivityEntry }`. Both branches
carry the entry the transaction wrote, so the caller can broadcast it without
re-reading the log.

`LockInfo` is the stored record (`ownerSessionId`, `ownerName`, `acquiredAtMs`,
`expiresAtMs`); `LockState` is what `GET /api/lock` and the sockets send.

Lock state is the only thing the server sends differently per socket: each socket
receives `{ lock: getLockState(socket.data.sessionId) }`, because names are not
unique and two sessions may share one. Every other event is identical for
everyone. Slice 05 owns the implementation.

## 10. Conventions

- Server code is CommonJS (`tsconfig.json`, `module: "commonjs"`, `outDir: "dist"`).
  Client code is browser-native ES modules (`tsconfig.client.json`,
  `module: "ESNext"`, `moduleResolution: "bundler"`, `outDir: "public/js"`,
  `lib: ["ES2022", "DOM"]`). Both configs set `rootDir: "src"` and include
  `src/shared`, which is why the server entry is `dist/server/index.js` and the
  browser entry is `/js/client/main.js`.
- `src/shared/types.ts` holds the types both sides use (`Account`, `ActivityEntry`,
  `LockState`, `Session`) and nothing else. It has no runtime behaviour; import it
  with `import type`, so nothing is loaded over the wire.
- Client code imports shared types as `import type { Account } from "../shared/types.js"`.
  The `.js` extension is required by native ES modules and is erased by `import type`.
- Files export named functions. No classes except `ApiError` and the Socket.IO
  server.
- `ApiError` carries `status` and `code`; the error middleware turns it into
  §6.1 and logs anything else at 500.
- No `console.log` in request paths other than the startup banner and errors.
- Every mutating request is wrapped in one `db.transaction(...)`.
- Test files sit next to the concern they test and use a fresh `:memory:`
  database via `openDatabase(":memory:")`.
