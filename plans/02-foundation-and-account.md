# Foundation, Shared Account and Activity Logger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node/Express/TypeScript server that serves a placeholder page, exposes `GET /api/health` and `GET /api/account`, owns exactly one SQLite account row seeded at `$1,000.00`, and records/reads append-only activity-log entries with server-local timestamps and server-rendered messages.

**Architecture:** Six small layers, each with one job: `config` (environment), `money`/`time` (pure helpers), `db` (schema, seed, migrations), `activity`/`account` (domain functions that take the database as their first argument), and `http` (Express app, routes, error handler). The database handle is created once in `index.ts` and passed down through `createApp({ db })`, so tests build the app against their own `:memory:` database.

**Tech Stack:** Node.js 20+, TypeScript (`strict`), Express 4, better-sqlite3, Vitest, Supertest.

**Spec:** `specs/02-foundation-and-account.md` (implements `specs/01-contracts.md` §1–§6, §8–§10)

## Global Constraints

- Node.js 20 LTS or newer; everything installed with `npm`; open source only.
- Money is AUD, never a float: balances and amounts are integer **cents** in variables, requests and columns named `...Cents` / `..._cents`. Display goes through `formatAUD`.
- Timestamps are the **server's** local time, rendered by the server. Use `Intl.DateTimeFormat("en-AU", { hour12: false })` with **no `timeZone` option**. Clients never reformat a stored timestamp.
- There is exactly one shared account (`account.id = 1`). No per-user balance anywhere.
- The activity log is append-only. `amount_cents`/`balance_after_cents` are `NULL` for `login` and `logout`.
- SQL values are always bound parameters; never interpolate a value into a SQL string.
- Server code is CommonJS (`module: "commonjs"`, `outDir: "dist"`); `src/shared/types.ts` holds types only.
- `strict: true`, no `any`, no `@ts-ignore` in `src/`.
- Files export named functions. The only class in this slice is `ApiError`.
- No `console.log` in request paths — only the startup banner and error logging.
- Every error response is `{ "error": { "code": string, "message": string } }` with the HTTP status from `specs/01-contracts.md` §6.1.
- Keep the code simple and readable; the complexity of the code should match the complexity of the problem.

## Decisions Made By This Plan

The spec leaves these open; the plan fixes them so the executor does not have to guess.

1. **No mutable database global.** `openDatabase()` returns the handle; `index.ts` holds it and passes it to `createApp({ db })`, which passes it to `createAccountRouter(db)`. This is what `02` §3 means by "the route layer supplies the singleton" — tests never share a handle.
2. **`account.ts` imports `ApiError` from `http/errors.ts`.** `01` §2 draws the dependency arrow `account → db|money`, and `02` §3 requires `getAccount` to throw `ApiError`. `errors.ts` imports nothing from the domain, so it is a leaf and this one upward import is deliberate.
3. **`LAN_URLS` holds bare IPv4 addresses** (`"192.168.1.24"`), as `01` §3 says ("every non-internal IPv4 address"). The banner adds `http://` and the port.
4. **Unknown routes return `404 NOT_FOUND`.** Express would otherwise answer with HTML, which `02` §6 forbids. Add that row to `specs/01-contracts.md` §6.1 in the same commit (Task 6, Step 1).
5. **Failed-event wording is driven by `reason`.** `01` §6.2 fixes the wording for `insufficient_funds` and `amount_too_large`; `06` §2 additionally records `invalid_amount`. `toPublicEntry` maps all three reasons, so a failed row never renders `null`. Slice 06 should add the `invalid_amount` wording to `01` §6.2.
6. **`transaction_cancelled` reads `Cancelled a withdrawal at …`** exactly as `01` §6.2 says. The entry cannot distinguish a deposit cancel yet; slice 07 (which adds `?cancelled=deposit`) owns widening `01` §6.2 and this branch.
7. **Tests import server modules without extensions** (`../../src/server/db`) because the server is CommonJS. The `.js`-suffixed imports `01` §2 requires are client-only and arrive with slice 03.
8. **No `vitest.config.ts`.** Vitest's default glob `**/*.test.ts` finds `tests/server/*.test.ts` and resolves TypeScript sources.

## Review Focus

Inputs and failure modes the spec implies but does not test. Each has a test pinned in the task named.

1. Balances above `$9,999.99` must keep grouping intact (`$1,234,567.89`, not `$1234567.89`) — Task 2.
2. A non-numeric `limit` reaching `listEntries` (later `?limit=abc`) must fall back to `50`, not throw or produce `LIMIT NaN` — Task 4.
3. Two entries written in the same millisecond must keep a stable order, broken by `id` — Task 4.
4. First run on a machine with no `data/` directory must create it rather than crash — Task 3.
5. A missing account row (failed seed, manual tampering) must answer `500 INTERNAL` with no stack trace in the body — Tasks 5 and 6.

## File Structure

| File | Responsibility |
|------|----------------|
| `package.json`, `tsconfig.json`, `.gitignore` | Build, scripts, ignored artefacts |
| `src/shared/types.ts` | `Session`, `Account`, `ActivityEntry`, `LockState` — types only |
| `src/server/config.ts` | Read the environment once, export constants and `LAN_URLS` |
| `src/server/money.ts` | Cents ↔ display strings |
| `src/server/time.ts` | Server-local date/time strings |
| `src/server/db.ts` | Open, migrate, seed; schema string |
| `src/server/activity.ts` | `recordEvent`, `listEntries`, `toPublicEntry` |
| `src/server/account.ts` | `getAccount` |
| `src/server/http/errors.ts` | `ApiError`, error middleware, 404 handler |
| `src/server/http/routes/account.ts` | `GET /api/health`, `GET /api/account` |
| `src/server/app.ts` | Express app assembly (no `listen`) |
| `src/server/index.ts` | Open db, listen, banner, `EADDRINUSE` |
| `public/index.html`, `public/css/atm.css` | Placeholder page and empty stylesheet |

---

### Task 1: Project scaffold and configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/shared/types.ts`, `src/server/config.ts`, `tests/server/config.test.ts`
- Replace: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: the constants of `01` §3 (`PORT`, `HOST`, `DB_PATH`, `INITIAL_BALANCE_CENTS`, `MAX_DEPOSIT_CENTS`, `MAX_AMOUNT_DIGITS`, `MIN_NAME_LENGTH`, `MAX_NAME_LENGTH`, `MULTITAP_WINDOW_MS`, `LOCK_LEASE_MS`, `LOCK_RENEW_MS`, `AI_CONTEXT_LIMIT`, `AI_TIMEOUT_MS`, `OLLAMA_URL`, `OLLAMA_MODEL`, `SESSION_COOKIE`, `SESSION_GRACE_MS`, `LAN_URLS`), and the types `Session`, `Account`, `ActivityEntry`, `LockState` from `src/shared/types.ts`.

- [ ] **Step 1: Write `package.json`, `tsconfig.json` and `.gitignore`**

`package.json` — no `"type": "module"` (the server is CommonJS):

```json
{
  "name": "atm-ai",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server/index.js",
    "dev": "npm run build && node --watch dist/server/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": { "node": ">=20" }
}
```

`tsconfig.json` (the five options `02` §2 pins, plus `esModuleInterop` for the Express default import and `sourceMap` so logged stacks point at source):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/server/**/*.ts", "src/shared/**/*.ts"]
}
```

`.gitignore` (four lines):

```
node_modules/
dist/
data/
public/js/
```

- [ ] **Step 2: Install dependencies**

```bash
npm install express@^4.21.2 better-sqlite3
npm install -D typescript vitest supertest @types/express@^4 @types/better-sqlite3 @types/node @types/supertest
```

Expected: `node_modules/` exists and `package.json` now lists dependencies in the two blocks.

- [ ] **Step 3: Write `src/shared/types.ts`**

Copy the four types from `01` §6.2 verbatim. Types only — no runtime values:

```ts
export type Session = { userName: string };
export type Account = { balanceCents: number; balanceFormatted: string; updatedAtMs: number };
export type ActivityEntry = { /* exactly the 11 fields of 01 §6.2 */ };
export type LockState = { /* exactly the 5 fields of 01 §6.2 */ };
```

`ActivityEntry["eventType"]` is the union of the seven event names — later tasks index it.

- [ ] **Step 4: Write the failing config test**

`tests/server/config.test.ts`:

```ts
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PORT;
  delete process.env.INITIAL_BALANCE_CENTS;
});

describe("config", () => {
  it("uses the documented defaults", async () => {
    const config = await import("../../src/server/config");
    expect(config.PORT).toBe(3000);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.DB_PATH).toBe("data/atm.db");
    expect(config.INITIAL_BALANCE_CENTS).toBe(100000);
    expect(config.MAX_DEPOSIT_CENTS).toBe(1000000);
    expect(config.MAX_AMOUNT_DIGITS).toBe(7);
    expect(config.MIN_NAME_LENGTH).toBe(3);
    expect(config.MAX_NAME_LENGTH).toBe(20);
    expect(config.MULTITAP_WINDOW_MS).toBe(800);
    expect(config.LOCK_LEASE_MS).toBe(30000);
    expect(config.LOCK_RENEW_MS).toBe(10000);
    expect(config.AI_CONTEXT_LIMIT).toBe(50);
    expect(config.AI_TIMEOUT_MS).toBe(20000);
    expect(config.OLLAMA_URL).toBe("http://127.0.0.1:11434");
    expect(config.OLLAMA_MODEL).toBe("llama3.2:3b");
    expect(config.SESSION_COOKIE).toBe("atm_sid");
    expect(config.SESSION_GRACE_MS).toBe(60000);
  });

  it("reads overrides from the environment", async () => {
    process.env.PORT = "4000";
    process.env.INITIAL_BALANCE_CENTS = "250";
    const config = await import("../../src/server/config");
    expect(config.PORT).toBe(4000);
    expect(config.INITIAL_BALANCE_CENTS).toBe(250);
  });

  it("lists only non-internal IPv4 LAN addresses", async () => {
    const { LAN_URLS } = await import("../../src/server/config");
    expect(Array.isArray(LAN_URLS)).toBe(true);
    for (const address of LAN_URLS) {
      expect(address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
      expect(address).not.toBe("127.0.0.1");
    }
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run tests/server/config.test.ts`
Expected: FAIL — Vitest cannot resolve `../../src/server/config`.

- [ ] **Step 6: Write `src/server/config.ts`**

Read `process.env` once at import time and export `const`s. Two private helpers keep it short: `intEnv(name, fallback)` (`process.env[name]` missing or empty → fallback; otherwise `Number(...)`, falling back when the result is not finite) and `lanAddresses()` (flatten `os.networkInterfaces()`, keep entries whose `family === "IPv4"` and `!internal`, map to `.address`). `MAX_DEPOSIT_CENTS`, `MAX_AMOUNT_DIGITS`, `MIN_NAME_LENGTH`, `MAX_NAME_LENGTH`, `MULTITAP_WINDOW_MS`, `LOCK_RENEW_MS`, `AI_CONTEXT_LIMIT`, `AI_TIMEOUT_MS` and `SESSION_COOKIE` are constants with no env var.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/server/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Verify the build compiles the strict config**

Run: `npm run build`
Expected: exit 0, no TypeScript errors; `dist/server/config.js` exists.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/shared/types.ts src/server/config.ts tests/server/config.test.ts
git commit -m "feat: scaffold TypeScript server and configuration"
```

---

### Task 2: Money, server-local time, and the API error type

**Files:**
- Create: `src/server/money.ts`, `src/server/time.ts`, `src/server/http/errors.ts`, `tests/server/money.test.ts`, `tests/server/time.test.ts`, `tests/server/errors.test.ts`

**Interfaces:**
- Consumes: `MAX_AMOUNT_DIGITS` from `config.ts`.
- Produces: `formatAUD(cents: number): string`, `digitsToCents(digits: string): number`, `isValidAmount(digits: string): boolean`, `LocalStamp`, `localStamp(now?: number): LocalStamp`, `formatLocalDateTime(timestampMs: number): string`, `class ApiError` with `status: number` and `code: string`.

- [ ] **Step 1: Write the failing money test**

`tests/server/money.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { digitsToCents, formatAUD, isValidAmount } from "../../src/server/money";

describe("formatAUD", () => {
  it("formats dollars and cents", () => expect(formatAUD(100000)).toBe("$1,000.00"));
  it("formats one cent", () => expect(formatAUD(1)).toBe("$0.01"));
  it("formats zero", () => expect(formatAUD(0)).toBe("$0.00"));
  it("keeps grouping above one million", () => expect(formatAUD(123456789)).toBe("$1,234,567.89"));
  it("rejects negative cents", () => expect(() => formatAUD(-1)).toThrow());
});

describe("digitsToCents", () => {
  it("treats typed digits as whole dollars", () => expect(digitsToCents("500")).toBe(50000));
  it("converts zero", () => expect(digitsToCents("0")).toBe(0));
  it.each(["", "abc", "1.5", "12345678", "-5", " 5"])("throws on %s", (input) => {
    expect(() => digitsToCents(input)).toThrow();
  });
});

describe("isValidAmount", () => {
  it.each(["1", "500", "1234567"])("accepts %s", (digits) => {
    expect(isValidAmount(digits)).toBe(true);
  });
  it.each(["0", "", "12345678", "1.5", "abc"])("rejects %s", (digits) => {
    expect(isValidAmount(digits)).toBe(false);
  });
  it("accepts leading zeros because the spec only counts digits", () => {
    expect(isValidAmount("007")).toBe(true);
  });
});
```

That last case documents a real consequence of `01` §4: `"007"` is 1–7 digits and above zero, so it is valid. If that is not wanted, the spec must change — do not silently special-case it.

- [ ] **Step 2: Write the failing time test**

`tests/server/time.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatLocalDateTime, localStamp } from "../../src/server/time";

const KNOWN_MS = 1763200000000;

describe("localStamp", () => {
  it("keeps the timestamp it was given", () => {
    expect(localStamp(KNOWN_MS).timestampMs).toBe(KNOWN_MS);
  });

  it("produces a zero-padded local date and 24-hour time", () => {
    const stamp = localStamp(KNOWN_MS);
    expect(stamp.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(stamp.localTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("defaults to now", () => {
    const before = Date.now();
    expect(localStamp().timestampMs).toBeGreaterThanOrEqual(before);
  });

  it("formats date and time together", () => {
    const stamp = localStamp(KNOWN_MS);
    expect(formatLocalDateTime(KNOWN_MS)).toBe(`${stamp.localDate} ${stamp.localTime}`);
  });
});
```

- [ ] **Step 3: Write the failing error-type test**

`tests/server/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/server/http/errors";

describe("ApiError", () => {
  it("carries a status, a code and a person-readable message", () => {
    const error = new ApiError(409, "NAME_TAKEN", "That name is already in use.");
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(409);
    expect(error.code).toBe("NAME_TAKEN");
    expect(error.message).toBe("That name is already in use.");
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/server/money.test.ts tests/server/time.test.ts tests/server/errors.test.ts`
Expected: FAIL — none of the three modules resolve.

- [ ] **Step 5: Write the three implementation modules**

`src/server/money.ts` — one module-level `Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" })`; `formatAUD` throws `RangeError` on a negative value and returns `formatter.format(cents / 100)` (display only — never feed this back into logic). `digitsToCents` throws `RangeError` unless the input matches `^\d{1,${MAX_AMOUNT_DIGITS}}$`, then returns `Number(digits) * 100`. `isValidAmount` is that same pattern **and** `Number(digits) > 0`.

`src/server/time.ts` — one module-level `Intl.DateTimeFormat("en-AU", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })` with **no `timeZone`**. A private `partsOf(timestampMs)` turns `formatToParts` into a `Record<string, string>`; `localStamp` assembles `YYYY-MM-DD` and `HH:MM:SS` from it; `formatLocalDateTime` returns `${localDate} ${localTime}` from the same call so the two can never disagree.

`src/server/http/errors.ts` — for now only:

```ts
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/server/money.test.ts tests/server/time.test.ts tests/server/errors.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/money.ts src/server/time.ts src/server/http/errors.ts tests/server/money.test.ts tests/server/time.test.ts tests/server/errors.test.ts
git commit -m "feat: add money, server-local time and ApiError"
```

---

### Task 3: Database schema, seed and persistence

**Files:**
- Create: `src/server/db.ts`, `tests/server/db.test.ts`

**Interfaces:**
- Consumes: `INITIAL_BALANCE_CENTS` from `config.ts`.
- Produces: `openDatabase(dbPath: string): Database.Database` — creates missing parent directories, enables WAL (file databases only) and foreign keys, applies the schema, sets `user_version = 1`, and seeds `account` exactly once.

- [ ] **Step 1: Write the failing database test**

`tests/server/db.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/server/db";

let open: Database.Database[] = [];

function openTracked(dbPath: string): Database.Database {
  const db = openDatabase(dbPath);
  open.push(db);
  return db;
}

function tempPath(...segments: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atm-test-"));
  return path.join(dir, ...segments);
}

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

describe("openDatabase", () => {
  it("seeds exactly one account row with $1,000.00", () => {
    const db = openTracked(":memory:");
    expect(db.prepare("SELECT id, balance_cents FROM account").all()).toEqual([
      { id: 1, balance_cents: 100000 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM user_names").get()).toEqual({ n: 0 });
  });

  it("creates the three tables and the timestamp index", () => {
    const db = openTracked(":memory:");
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
      .all() as { name: string }[];
    expect(names.map((row) => row.name)).toEqual(
      expect.arrayContaining(["account", "activity_log", "activity_log_timestamp_idx", "user_names"]),
    );
  });

  it("records the schema version", () => {
    const db = openTracked(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(1);
  });

  it("creates missing parent directories", () => {
    const file = tempPath("nested", "data", "atm.db");
    openTracked(file);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("uses WAL for file databases", () => {
    const db = openTracked(tempPath("atm.db"));
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("keeps a changed balance across close and reopen without re-seeding", () => {
    const file = tempPath("atm.db");
    const first = openDatabase(file);
    first.prepare("UPDATE account SET balance_cents = ?, updated_at_ms = ? WHERE id = 1").run(12345, 1);
    first.close();

    const second = openDatabase(file);
    expect(second.prepare("SELECT balance_cents FROM account WHERE id = 1").get()).toEqual({
      balance_cents: 12345,
    });
    expect(second.prepare("SELECT COUNT(*) AS n FROM account").get()).toEqual({ n: 1 });
    second.close();
  });

  it("opens an existing database without throwing", () => {
    const file = tempPath("atm.db");
    openTracked(file);
    expect(() => openTracked(file)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/server/db.test.ts`
Expected: FAIL — `../../src/server/db` does not resolve.

- [ ] **Step 3: Write `src/server/db.ts`**

Order inside `openDatabase`, exactly as `02` §3 lists it:

1. If `dbPath !== ":memory:"`, `fs.mkdirSync(path.dirname(dbPath), { recursive: true })`.
2. `new Database(dbPath)`; if it is a file, `db.pragma("journal_mode = WAL")`; always `db.pragma("foreign_keys = ON")`.
3. `db.exec(SCHEMA_SQL)` then `db.pragma("user_version = 1")`.
4. Seed inside one `db.transaction`: `SELECT COUNT(*) AS n FROM account`; when `n === 0`, insert `(1, INITIAL_BALANCE_CENTS, Date.now())`.

`SCHEMA_SQL` is the schema of `01` §8 copied verbatim — the three `CREATE TABLE IF NOT EXISTS` statements and the `CREATE INDEX IF NOT EXISTS activity_log_timestamp_idx`. It is a module-private constant; indexes are never created outside it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/server/db.test.ts`
Expected: PASS (7 tests); no open-handle warning.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts tests/server/db.test.ts
git commit -m "feat: open, migrate and seed the SQLite account database"
```

---

### Task 4: Activity log writer and reader

**Files:**
- Create: `src/server/activity.ts`, `tests/server/activity.test.ts`

**Interfaces:**
- Consumes: `ActivityEntry` from `src/shared/types.ts`; `formatAUD` from `money.ts`; `localStamp` from `time.ts`; `MAX_DEPOSIT_CENTS` from `config.ts`; an open database.
- Produces:
  - `interface RecordEventInput { eventType: ActivityEntry["eventType"]; userName: string; amountCents?: number | null; balanceAfterCents?: number | null; reason?: string | null }`
  - `interface EntryFilter { eventType?: ActivityEntry["eventType"]; userName?: string; fromMs?: number; toMs?: number; limit?: number }`
  - `interface ActivityRow` — the snake_case column shape of `activity_log`
  - `recordEvent(db, input): ActivityEntry`, `listEntries(db, filter?): ActivityEntry[]`, `toPublicEntry(row): ActivityEntry`

- [ ] **Step 1: Write the failing message test**

`tests/server/activity.test.ts` — start with `toPublicEntry`, which is pure:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { listEntries, recordEvent, toPublicEntry, type ActivityRow } from "../../src/server/activity";
import { openDatabase } from "../../src/server/db";

function row(overrides: Partial<ActivityRow>): ActivityRow {
  return {
    id: 1,
    event_type: "login",
    user_name: "User1",
    amount_cents: null,
    balance_after_cents: null,
    reason: null,
    timestamp_ms: 1763200000000,
    local_date: "2026-11-15",
    local_time: "12:40:00",
    ...overrides,
  };
}

describe("toPublicEntry", () => {
  it.each([
    [{ event_type: "login", local_time: "12:30:45" }, "User1: Logged in at 12:30:45"],
    [{ event_type: "logout", local_time: "12:41:00" }, "User1: Logged out at 12:41:00"],
    [{ event_type: "withdraw", amount_cents: 500000 }, "User1: Withdrew $5,000.00 at 12:40:00"],
    [{ event_type: "deposit", amount_cents: 50000 }, "User1: Deposited $500.00 at 12:40:00"],
    [
      { event_type: "withdraw_failed", amount_cents: 500000, reason: "insufficient_funds" },
      "User1: Withdrawal of $5,000.00 failed (insufficient funds) at 12:40:00",
    ],
    [
      { event_type: "deposit_failed", amount_cents: 1200000, reason: "amount_too_large" },
      "User1: Deposit of $12,000.00 failed (above the $10,000.00 limit) at 12:40:00",
    ],
    [
      { event_type: "withdraw_failed", amount_cents: 0, reason: "invalid_amount" },
      "User1: Withdrawal of $0.00 failed (invalid amount) at 12:40:00",
    ],
    [{ event_type: "transaction_cancelled" }, "User1: Cancelled a withdrawal at 12:40:00"],
  ])("renders %j", (overrides, expected) => {
    expect(toPublicEntry(row(overrides as Partial<ActivityRow>)).message).toBe(expected);
  });

  it("maps every column onto the public entry", () => {
    const entry = toPublicEntry(
      row({ id: 7, event_type: "deposit", amount_cents: 50000, balance_after_cents: 105000, reason: "cancelled" }),
    );
    expect(entry).toMatchObject({
      id: 7,
      eventType: "deposit",
      userName: "User1",
      amountCents: 50000,
      balanceAfterCents: 105000,
      reason: "cancelled",
      timestampMs: 1763200000000,
      localDate: "2026-11-15",
      localTime: "12:40:00",
    });
  });
});
```

- [ ] **Step 2: Write the failing writer/reader tests (same file)**

Add the shared database handle and the raw-insert helper. The helper exists because `recordEvent` always stamps "now" and the ordering tests need control over `timestamp_ms`:

```ts
let db: Database.Database;
beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
});

function insertRaw(
  eventType: string,
  userName: string,
  timestampMs: number,
  localDate = "2026-11-15",
  localTime = "12:00:00",
): void {
  db.prepare(
    `INSERT INTO activity_log
       (event_type, user_name, amount_cents, balance_after_cents, reason, timestamp_ms, local_date, local_time)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(eventType, userName, timestampMs, localDate, localTime);
}

describe("recordEvent", () => {
  it("stamps the row itself and returns the public entry", () => {
    const before = Date.now();
    const entry = recordEvent(db, {
      eventType: "withdraw",
      userName: "USER1",
      amountCents: 500000,
      balanceAfterCents: 50000,
    });

    expect(entry.timestampMs).toBeGreaterThanOrEqual(before);
    expect(entry.message).toBe(`USER1: Withdrew $5,000.00 at ${entry.localTime}`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_log").get()).toEqual({ n: 1 });
  });

  it("stores null amount and balance for a login", () => {
    const entry = recordEvent(db, { eventType: "login", userName: "USER1" });
    expect(entry.amountCents).toBeNull();
    expect(entry.balanceAfterCents).toBeNull();
  });
});

describe("listEntries", () => {
  it("returns zero rows for an empty log", () => {
    expect(listEntries(db)).toEqual([]);
  });

  it("orders by timestamp, then id", () => {
    insertRaw("login", "SECOND", 2000);
    insertRaw("login", "FIRST", 1000);
    insertRaw("login", "THIRD", 3000);
    expect(listEntries(db).map((entry) => entry.userName)).toEqual(["FIRST", "SECOND", "THIRD"]);
  });

  it("keeps insertion order for rows in the same millisecond", () => {
    insertRaw("login", "A", 1000);
    insertRaw("login", "B", 1000);
    expect(listEntries(db).map((entry) => entry.userName)).toEqual(["A", "B"]);
  });

  it("filters by event type and user name", () => {
    insertRaw("login", "A", 1000);
    insertRaw("deposit", "A", 2000);
    insertRaw("deposit", "B", 3000);
    expect(listEntries(db, { eventType: "deposit" }).map((e) => e.userName)).toEqual(["A", "B"]);
    expect(listEntries(db, { userName: "A" }).map((e) => e.eventType)).toEqual(["login", "deposit"]);
    expect(listEntries(db, { eventType: "deposit", userName: "B" })).toHaveLength(1);
  });

  it("filters by an inclusive time window", () => {
    insertRaw("login", "A", 1000);
    insertRaw("login", "B", 2000);
    insertRaw("login", "C", 3000);
    expect(listEntries(db, { fromMs: 2000, toMs: 3000 }).map((e) => e.userName)).toEqual(["B", "C"]);
  });

  it("returns no rows for an unknown event type", () => {
    insertRaw("login", "A", 1000);
    expect(listEntries(db, { eventType: "transfer" as never })).toEqual([]);
  });

  it("treats a hostile user name as data, not SQL", () => {
    insertRaw("login", "A", 1000);
    expect(listEntries(db, { userName: "' OR 1=1 --" })).toEqual([]);
  });

  it("defaults to 50, clamps to 1..200 and survives a non-numeric limit", () => {
    for (let i = 1; i <= 205; i += 1) insertRaw("login", `U${i}`, i);
    expect(listEntries(db)).toHaveLength(50);
    expect(listEntries(db, { limit: 0 })).toHaveLength(1);
    expect(listEntries(db, { limit: 500 })).toHaveLength(200);
    expect(listEntries(db, { limit: Number.NaN })).toHaveLength(50);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/server/activity.test.ts`
Expected: FAIL — `../../src/server/activity` does not resolve.

- [ ] **Step 4: Write `src/server/activity.ts`**

`recordEvent` calls `localStamp()` itself (never accepts a timestamp), inserts all nine columns with bound parameters, then reads the row back by `lastInsertRowid` and returns `toPublicEntry(row)`.

`listEntries` pushes `event_type = ?`, `user_name = ?`, `timestamp_ms >= ?`, `timestamp_ms <= ?` into a `WHERE` parts array with a matching parameters array, joins them with ` AND `, and appends `ORDER BY timestamp_ms ASC, id ASC LIMIT ?`. The limit comes from a private `clampLimit(value)`: `Number(undefined)` or `NaN` → 50; otherwise `Math.min(200, Math.max(1, Math.trunc(value)))`.

`toPublicEntry` maps columns to camelCase and builds `message` with a `switch` on `event_type`; failed rows get their parenthetical from a private `failureText(reason)` map: `insufficient_funds` → `"insufficient funds"`, `amount_too_large` → `` `above the ${formatAUD(MAX_DEPOSIT_CENTS)} limit` ``, anything else → `"invalid amount"`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/server/activity.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/activity.ts tests/server/activity.test.ts
git commit -m "feat: record and list activity-log entries"
```

---

### Task 5: Account read model

**Files:**
- Create: `src/server/account.ts`, `tests/server/account.test.ts`

**Interfaces:**
- Consumes: `Account` from `src/shared/types.ts`, `formatAUD` from `money.ts`, `ApiError` from `http/errors.ts`.
- Produces: `getAccount(db: Database.Database): Account` — `{ balanceCents, balanceFormatted, updatedAtMs }`.

- [ ] **Step 1: Write the failing test**

`tests/server/account.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/server/db";
import { getAccount } from "../../src/server/account";
import { ApiError } from "../../src/server/http/errors";

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("getAccount", () => {
  it("returns the seeded balance formatted as AUD", () => {
    const account = getAccount(db);
    expect(account.balanceCents).toBe(100000);
    expect(account.balanceFormatted).toBe("$1,000.00");
    expect(typeof account.updatedAtMs).toBe("number");
  });

  it("reflects a stored balance change", () => {
    db.prepare("UPDATE account SET balance_cents = ?, updated_at_ms = ? WHERE id = 1").run(1, 42);
    expect(getAccount(db)).toEqual({
      balanceCents: 1,
      balanceFormatted: "$0.01",
      updatedAtMs: 42,
    });
  });

  it("throws INTERNAL when the account row is missing", () => {
    db.exec("DELETE FROM account");
    expect(() => getAccount(db)).toThrow(ApiError);
    try {
      getAccount(db);
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.status).toBe(500);
      expect(apiError.code).toBe("INTERNAL");
      expect(apiError.message).toBe("Account is missing.");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/server/account.test.ts`
Expected: FAIL — `../../src/server/account` does not resolve.

- [ ] **Step 3: Write `src/server/account.ts`**

One prepared `SELECT balance_cents, updated_at_ms FROM account WHERE id = 1`; when `get()` returns `undefined`, throw `new ApiError(500, "INTERNAL", "Account is missing.")`; otherwise return the `Account` with `formatAUD(balance_cents)`. `withdraw`/`deposit` belong to slice 06 — do not add them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/server/account.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/account.ts tests/server/account.test.ts
git commit -m "feat: read the shared account balance"
```

---

### Task 6: HTTP app, routes, page and startup

**Files:**
- Create: `src/server/http/routes/account.ts`, `src/server/app.ts`, `src/server/index.ts`, `public/index.html`, `public/css/atm.css`, `tests/server/app.test.ts`
- Modify: `src/server/http/errors.ts` (add `errorHandler`, `notFoundHandler`), `tests/server/errors.test.ts` (middleware tests)
- Modify: `specs/01-contracts.md` (add the `404 NOT_FOUND` row to §6.1)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `createAccountRouter(db): express.Router` serving `GET /health` and `GET /account`; `createApp(deps: { db }): express.Express`; `errorHandler(err, req, res, next)`; `notFoundHandler(req, res)`; the runnable entry `dist/server/index.js`.

- [ ] **Step 1: Add the 404 row to the contract**

In `specs/01-contracts.md` §6.1, add below the `500 INTERNAL` row:

```
| 404 | `NOT_FOUND` | No route matches the request |
```

`message` shown to the user is `"Not found."`.

- [ ] **Step 2: Write the failing middleware tests**

Replace the import lines at the top of `tests/server/errors.test.ts` with these (they keep `ApiError` and add the middleware), then append the three test blocks:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ApiError, errorHandler, notFoundHandler } from "../../src/server/http/errors";

describe("errorHandler", () => {
  it("returns an ApiError with its status and 01 §6.1 shape", async () => {
    const app = express();
    app.get("/boom", () => {
      throw new ApiError(409, "NAME_TAKEN", "That name is already in use.");
    });
    app.use(errorHandler);

    const res = await request(app).get("/boom");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: "NAME_TAKEN", message: "That name is already in use." },
    });
  });

  it("turns an unknown error into 500 INTERNAL without leaking the stack", async () => {
    const app = express();
    app.get("/boom", () => {
      throw new Error("database is on fire");
    });
    app.use(errorHandler);

    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "INTERNAL", message: "Something went wrong." } });
    expect(JSON.stringify(res.body)).not.toContain("on fire");
  });
});

describe("notFoundHandler", () => {
  it("answers an unknown route with the error shape", async () => {
    const app = express();
    app.use(notFoundHandler);

    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found." } });
  });
});
```

- [ ] **Step 3: Write the failing app test**

`tests/server/app.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import request from "supertest";
import { createApp } from "../../src/server/app";
import { openDatabase } from "../../src/server/db";

let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDatabase(":memory:");
  app = createApp({ db });
});

afterEach(() => {
  db.close();
});

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("GET /api/account", () => {
  it("returns the shared account", async () => {
    const res = await request(app).get("/api/account");
    expect(res.status).toBe(200);
    expect(res.body.account.balanceCents).toBe(100000);
    expect(res.body.account.balanceFormatted).toBe("$1,000.00");
    expect(typeof res.body.account.updatedAtMs).toBe("number");
  });

  it("returns 500 INTERNAL and no stack when the balance row is gone", async () => {
    db.exec("DELETE FROM account");
    const res = await request(app).get("/api/account");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "INTERNAL", message: "Something went wrong." } });
  });
});

describe("unknown routes", () => {
  it("answer /api/... with the error shape", async () => {
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("answer a missing static file with the error shape", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("static files", () => {
  it("serves the placeholder page", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain('id="app"');
  });

  it("serves the stylesheet", async () => {
    const res = await request(app).get("/css/atm.css");
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/server/errors.test.ts tests/server/app.test.ts`
Expected: FAIL — `errorHandler`, `createApp` and the public files do not exist.

- [ ] **Step 5: Write the error middleware**

Append to `src/server/http/errors.ts`:

- `errorHandler(err: unknown, req, res, next)` — four parameters so Express recognises it as an error handler, even though `next` is unused. `ApiError` → `res.status(err.status).json({ error: { code: err.code, message } })` where `message` is `err.message` for 4xx codes and `"Something went wrong."` for a 500 `ApiError` (500 details are logged, not returned, per `01` §6.1). Anything else → `console.error(err)` (the stack) and `res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong." } })`.
- `notFoundHandler(req, res)` — `res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found." } })`.

- [ ] **Step 6: Write the route, app and entry point**

`src/server/http/routes/account.ts`:

```ts
import { Router } from "express";
import type Database from "better-sqlite3";

export function createAccountRouter(db: Database.Database): Router;
```

Mounts `GET /health` → `res.json({ ok: true })` and `GET /account` → `res.json({ account: getAccount(db) })`. No session check yet — slice 04 adds `requireSession` to the real routes.

`src/server/app.ts` — `createApp(deps: { db })` builds the app in this order: `express.json()`, `app.use("/api", createAccountRouter(deps.db))`, `express.static("public")`, `notFoundHandler`, `errorHandler`. It never calls `listen`.

`src/server/index.ts` — the only file that listens. It imports `node:http`, `openDatabase` from `./db`, `createApp` from `./app`, and `DB_PATH`, `HOST`, `LAN_URLS`, `PORT` from `./config`:

```ts
const db = openDatabase(DB_PATH);
const app = createApp({ db });
const server = http.createServer(app);
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other process or set PORT.`);
    process.exit(1);
  }
  throw error;
});
server.listen(PORT, HOST, () => {
  console.log(`ATM running on http://localhost:${PORT}`);
  for (const address of LAN_URLS) console.log(`  http://${address}:${PORT}`);
});
```

- [ ] **Step 7: Write the placeholder page and stylesheet**

`public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ATM</title>
    <link rel="stylesheet" href="/css/atm.css" />
  </head>
  <body>
    <main id="app">ATM</main>
  </body>
</html>
```

`public/css/atm.css` — one line: `/* ATM styles arrive with slice 03. */`

- [ ] **Step 8: Run the full suite to verify it passes**

Run: `npm test`
Expected: PASS — all six test files, including the reopen-and-reread persistence test. The run exits on its own.

- [ ] **Step 9: Verify the build and the running server by hand**

```bash
npm run build
npm start
```

Expected: banner `ATM running on http://localhost:3000` plus one `http://<lan-ip>:3000` line. In a second shell:

```bash
curl -s localhost:3000/api/health          # {"ok":true}
curl -s localhost:3000/api/account         # {"account":{"balanceCents":100000,"balanceFormatted":"$1,000.00","updatedAtMs":...}}
curl -s localhost:3000/ | grep 'id="app"'  # <main id="app">ATM</main>
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/css/atm.css   # 200
curl -s localhost:3000/api/nope            # {"error":{"code":"NOT_FOUND","message":"Not found."}}
```

Stop the server with Ctrl-C. Then confirm persistence: `ls data/atm.db`, start again, and `curl localhost:3000/api/account` still reports `100000`. Stop the server, delete the database files with `rm -f data/atm.db*` (WAL leaves `-wal`/`-shm` files behind), start again, and it re-seeds `100000`.

- [ ] **Step 10: Commit**

```bash
git add src/server/http/errors.ts src/server/http/routes/account.ts src/server/app.ts src/server/index.ts public/index.html public/css/atm.css tests/server/errors.test.ts tests/server/app.test.ts specs/01-contracts.md
git commit -m "feat: serve health, account and the placeholder ATM page"
```

---

## Acceptance Criteria

Run after Task 6, from a fresh clone:

- [ ] `npm install && npm run build && npm start` all succeed.
- [ ] `curl localhost:3000/api/health` → `{"ok":true}`.
- [ ] `curl localhost:3000/api/account` → `{"account":{"balanceCents":100000,"balanceFormatted":"$1,000.00",…}}`.
- [ ] The banner lists the machine's LAN IP and the port.
- [ ] `/` shows the placeholder page; `/css/atm.css` loads.
- [ ] `npm test` passes, including the reopen-and-reread persistence test.
- [ ] Deleting `data/atm.db` re-seeds `$1,000.00`; restarting without deleting leaves the balance untouched.
- [ ] No route returns a stack trace or a non-`01` error shape.
