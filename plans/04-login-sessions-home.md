# Login, Sessions and Homepage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement login with multi-tap names, server-side cookie sessions, homepage with live balance and three buttons (Withdraw, Deposit, Sign out), and login/logout log entries.

**Depends on:** Slices 02 (foundation, account, activity log) and 03 (ATM shell, keypad, multi-tap, reducer, screens)

**Spec:** `specs/04-login-sessions-home.md`

## Global Constraints

- Sessions are in-memory (Map), identified by UUID cookie `atm_sid` (HttpOnly, SameSite=Lax, Path=/). No user data in cookie.
- Name registry in `user_names` table (persistent across restarts). Name = log identity.
- Liveness: session alive unless `sockets === 0` AND `now - absentSinceMs > SESSION_GRACE_MS` (60s default).
- Sweep every 5s in `index.ts`; sweep writes NO `logout` entry.
- Client: one `request()` helper with `credentials: "same-origin"`. `HttpError(status, code, message)`.
- Boot: check session, then login or home. 401 anywhere → login with "Session ended. Please log in again."
- Login screen: 3+ chars → debounced availability check (500ms). ENTER → POST /api/session.
- Home: balance from server, three real `<button>`s in `.atm__actions`. Sign out → DELETE /api/session.
- **Express is v4**: route handlers are synchronous (no `async`); a thrown `ApiError` only reaches `errorHandler` if it is a synchronous throw.
- **Keepalive:** the home screen re-sends `GET /api/session` every 20s while logged in, so an idle open tab keeps its session alive until slice 05 adds sockets.
- Response shapes are unwrapped by `api.ts`: server sends `{ session: {...} }` / `{ account: {...} }`, client returns `body.session` / `body.account`.
- `sessions.ts` exports `clearSessions()` for tests; every server test file clears it in `beforeEach` (the Map is module-global).

## Review Focus

1. **Race on same name** — two simultaneous POST `/api/session` with same name → exactly one 201, rest 409, one `login` row, one `user_names` row. Test: 20 agents `Promise.all`.
2. **Cookie round-trip** — `Set-Cookie` on login, sent back on subsequent requests (`.set("Cookie", ...)`), cleared on logout. Test: `session-routes.test.ts`.
3. **Liveness & sweep** — `setSessionSockets(id, 0)` starts grace clock; `getSession` returns `null` after grace; sweep destroys only past-grace sessions. Test: `sessions.test.ts` using `vi.useFakeTimers()` (grace advanced in test time; `SESSION_GRACE_MS` stays 60s).
4. **Name reuse after sign-out** — A signs out, B logs in as same name → 200, new session, new `login` row, same single `user_names` row. Test: `session-routes.test.ts`.
5. **Availability endpoint** — no cookie needed, no log row, `false` while held live, `true` after release. Test: `session-routes.test.ts`.
6. **401 anywhere** — client resets to login with specific banner, only place reacting to error code.
7. **Boot sequence** — `Checking session…` → `currentSession()` → login or home. Network failure → banner.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/server/sessions.ts` | In-memory session Map: `createSession`, `getSession`, `destroySession`, `readSessionId`, `setSessionSockets`, `findSessionByName`, `sweepSessions` |
| `src/server/names.ts` | `ensureName(db, name, nowMs?)` — upserts `user_names` |
| `src/server/http/requireSession.ts` | Middleware: reads cookie, attaches `res.locals.session` or 401 |
| `src/server/http/routes/session.ts` | `POST /api/session`, `GET /api/session`, `GET /api/session/availability`, `DELETE /api/session` |
| `src/client/api.ts` | `login`, `nameAvailable`, `currentSession`, `logout`, `getAccount`, `HttpError`, `request` |
| `src/client/messages.ts` | Banner strings shared by `main.ts` and `screens/login.ts`, `KEEPALIVE_MS` |
| `src/server/app.ts` | Mount session routes, apply `requireSession` to protected routes |
| `src/server/index.ts` | Start sweep interval (5s) |
| `src/client/state.ts` | Add `logout` action, `busy` handling, connection state |
| `src/client/main.ts` | Boot flow, `refreshSession()`, 401 handler |
| `src/client/screens/login.ts` | Debounced availability, ENTER → `login()`, busy state |
| `src/client/screens/home.ts` | Three buttons, sign out handler |
| `public/css/atm.css` | Add `.atm__actions` / `.atm__action` rules (no inline styles in JS) |
| `tests/server/sessions.test.ts` | Session CRUD, liveness, sweep |
| `tests/server/names.test.ts` | `ensureName` idempotency, persistence |
| `tests/server/session-routes.test.ts` | All routes, race, reuse, availability, gating |
| `tests/server/app.test.ts` | Update: `/api/account` now needs a session |
| `tests/client/router.test.ts` | Extended: login success, nameTaken, signOut |
| `tests/client/api.test.ts` | Response unwrapping (`{session}`, `{account}`), `HttpError` mapping |

---

## Task 1: Server — Sessions Module (`sessions.ts`)

**Files:** Create `src/server/sessions.ts`, `tests/server/sessions.test.ts`

**Interfaces:**
- Consumes: `SESSION_COOKIE`, `SESSION_GRACE_MS` from `config.ts`; `crypto.randomUUID()`
- Produces: Session type, `createSession(userName)`, `getSession(id)`, `destroySession(id)`, `readSessionId(cookieHeader)`, `setSessionSockets(id, n)`, `findSessionByName(name)`, `sweepSessions()`, `clearSessions()` (test-only reset of the module Map)

### Step 1: Write failing tests

```ts
// tests/server/sessions.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { 
  createSession, getSession, destroySession, readSessionId, 
  setSessionSockets, findSessionByName, sweepSessions, clearSessions 
} from "../../src/server/sessions";
import { SESSION_GRACE_MS } from "../../src/server/config";

// The session Map is module-global: every test starts from an empty store,
// otherwise earlier tests' sessions leak into liveness/sweep assertions.
beforeEach(() => {
  clearSessions();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Session IDs", () => {
  it("are distinct UUIDs", () => {
    const a = createSession("SIMON");
    const b = createSession("BLAKE");
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("getSession round-trips", () => {
  it("returns session and updates lastSeenMs", () => {
    const s = createSession("SIMON");
    const before = s.lastSeenMs;
    // Small delay to ensure timestamp changes
    const got = getSession(s.id);
    expect(got).not.toBeNull();
    expect(got!.lastSeenMs).toBeGreaterThanOrEqual(before);
    expect(got!.userName).toBe("SIMON");
  });

  it("returns null for destroyed session", () => {
    const s = createSession("SIMON");
    destroySession(s.id);
    expect(getSession(s.id)).toBeNull();
  });
});

describe("readSessionId", () => {
  it("parses simple cookie", () => {
    expect(readSessionId("atm_sid=abc123")).toBe("abc123");
  });
  it("parses with other cookies and spaces", () => {
    expect(readSessionId("a=1; atm_sid=xyz; b=2")).toBe("xyz");
    expect(readSessionId("a=1;atm_sid= xyz ;b=2")).toBe("xyz");
  });
  it("returns null for missing, empty, or no value", () => {
    expect(readSessionId("")).toBeNull();
    expect(readSessionId(undefined as any)).toBeNull();
    expect(readSessionId("atm_sid=")).toBeNull();
    expect(readSessionId("other=value")).toBeNull();
  });
});

describe("setSessionSockets liveness", () => {
  it("starts absence clock at 0, clears at >0", () => {
    const s = createSession("SIMON");
    const id = s.id;
    
    setSessionSockets(id, 0);
    // Inspect the session object directly — getSession clears absentSinceMs
    expect(s.absentSinceMs).not.toBeNull();
    expect(s.sockets).toBe(0);
    
    setSessionSockets(id, 1);
    expect(s.absentSinceMs).toBeNull();
    expect(s.sockets).toBe(1);
  });

  it("session past grace is dead", () => {
    const s = createSession("SIMON");
    const id = s.id;
    setSessionSockets(id, 0);
    
    // Fast-forward past grace
    vi.useFakeTimers();
    vi.advanceTimersByTime(SESSION_GRACE_MS + 1);
    
    expect(getSession(id)).toBeNull();
    vi.useRealTimers();
  });

  it("session within grace is alive", () => {
    const s = createSession("SIMON");
    const id = s.id;
    setSessionSockets(id, 0);
    
    vi.useFakeTimers();
    vi.advanceTimersByTime(SESSION_GRACE_MS - 1000);
    
    expect(getSession(id)).not.toBeNull();
    vi.useRealTimers();
  });
});

describe("setSessionSockets on unknown/destroyed ID is no-op", () => {
  it("does not throw", () => {
    expect(() => setSessionSockets("non-existent-id", 0)).not.toThrow();
    expect(() => setSessionSockets("non-existent-id", 5)).not.toThrow();
    
    const s = createSession("SIMON");
    destroySession(s.id);
    expect(() => setSessionSockets(s.id, 0)).not.toThrow();
  });
});

describe("findSessionByName applies liveness", () => {
  it("returns holder if session live", () => {
    const s = createSession("SIMON");
    expect(findSessionByName("SIMON")?.id).toBe(s.id);
  });

  it("returns null if session gone (past grace)", () => {
    const s = createSession("SIMON");
    const id = s.id;
    setSessionSockets(id, 0);
    
    vi.useFakeTimers();
    vi.advanceTimersByTime(SESSION_GRACE_MS + 1);
    
    expect(findSessionByName("SIMON")).toBeNull();
    vi.useRealTimers();
  });

  it("exact match only (SIMON ≠ ALEX)", () => {
    createSession("SIMON");
    expect(findSessionByName("ALEX")).toBeNull();
  });
});

describe("sweepSessions", () => {
  it("destroys only sessions past grace, returns them", () => {
    const a = createSession("SIMON");
    const b = createSession("BLAKE");
    setSessionSockets(a.id, 0);
    setSessionSockets(b.id, 1); // b has a live socket, so not absent
    
    vi.useFakeTimers();
    vi.advanceTimersByTime(SESSION_GRACE_MS + 1);
    
    const swept = sweepSessions();
    expect(swept.map(s => s.id)).toEqual([a.id]);
    expect(getSession(a.id)).toBeNull();
    expect(getSession(b.id)).not.toBeNull();
    
    const sweptAgain = sweepSessions();
    expect(sweptAgain).toHaveLength(0);
    vi.useRealTimers();
  });
});
```

### Step 2: Run tests to verify they fail
Run: `npx vitest run tests/server/sessions.test.ts`
Expected: FAIL — module not found

### Step 3: Implement `src/server/sessions.ts`

```ts
// src/server/sessions.ts
import { SESSION_COOKIE, SESSION_GRACE_MS } from "./config";

export interface Session {
  id: string;
  userName: string;
  sockets: number;
  lastSeenMs: number;
  absentSinceMs: number | null;
  createdAtMs: number;
}

const sessions = new Map<string, Session>();

export function createSession(userName: string): Session {
  const id = crypto.randomUUID();
  const now = Date.now();
  const session: Session = {
    id,
    userName,
    sockets: 0, // no WebSocket yet (slice 05); a later request/socket clears the clock
    lastSeenMs: now,
    absentSinceMs: now,
    createdAtMs: now,
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | null {
  const session = sessions.get(id);
  if (!session) return null;
  
  const now = Date.now();
  // Liveness check: dead if sockets === 0 AND absentSinceMs past grace
  if (session.sockets === 0 && session.absentSinceMs !== null) {
    if (now - session.absentSinceMs > SESSION_GRACE_MS) {
      sessions.delete(id);
      return null;
    }
  }
  
  // Request proves presence: refresh lastSeenMs, clear absentSinceMs
  session.lastSeenMs = now;
  session.absentSinceMs = null;
  return session;
}

export function destroySession(id: string): void {
  sessions.delete(id);
}

export function readSessionId(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      const value = valueParts.join("=").trim();
      return value || null;
    }
  }
  return null;
}

export function setSessionSockets(id: string, n: number): void {
  const session = sessions.get(id);
  if (!session) return; // no-op for unknown/destroyed
  
  const wasZero = session.sockets === 0;
  session.sockets = n;
  
  if (n === 0 && !wasZero) {
    // Just went to zero: start grace countdown
    session.absentSinceMs = Date.now();
  } else if (n > 0 && wasZero) {
    // Came back from zero: clear grace
    session.absentSinceMs = null;
  }
}

export function findSessionByName(name: string): Session | null {
  for (const session of sessions.values()) {
    if (session.userName === name) {
      // Apply liveness check inline
      const now = Date.now();
      if (session.sockets === 0 && session.absentSinceMs !== null) {
        if (now - session.absentSinceMs > SESSION_GRACE_MS) {
          continue; // dead, skip
        }
      }
      return session;
    }
  }
  return null;
}

export function sweepSessions(): Session[] {
  const now = Date.now();
  const swept: Session[] = [];
  
  for (const [id, session] of sessions.entries()) {
    if (session.sockets === 0 && session.absentSinceMs !== null) {
      if (now - session.absentSinceMs > SESSION_GRACE_MS) {
        sessions.delete(id);
        swept.push(session);
      }
    }
  }
  return swept;
}

/** Test-only: empty the store so tests do not leak sessions into each other. */
export function clearSessions(): void {
  sessions.clear();
}
```

### Step 4: Run tests to verify they pass
Run: `npx vitest run tests/server/sessions.test.ts`
Expected: PASS

### Step 5: Commit
```bash
git add src/server/sessions.ts tests/server/sessions.test.ts
git commit -m "feat: implement in-memory session store with liveness and sweep"
```

---

## Task 2: Server — Names Registry (`names.ts`)

**Files:** Create `src/server/names.ts`, `tests/server/names.test.ts`

**Interfaces:**
- Consumes: `Database` from `better-sqlite3`
- Produces: `ensureName(db, name, nowMs?) -> boolean`

### Step 1: Write failing tests

```ts
// tests/server/names.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/server/db";
import { ensureName } from "../../src/server/names";

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("ensureName", () => {
  it("returns true first time, false second, leaves one row", () => {
    expect(ensureName(db, "SIMON")).toBe(true);
    expect(ensureName(db, "SIMON")).toBe(false);
    expect(ensureName(db, "BLAKE")).toBe(true);

    const count = db.prepare("SELECT COUNT(*) AS n FROM user_names").get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("honours an explicit timestamp", () => {
    expect(ensureName(db, "SIMON", 12345)).toBe(true);
    const row = db.prepare("SELECT used_at_ms FROM user_names WHERE name = 'SIMON'").get() as { used_at_ms: number };
    expect(row.used_at_ms).toBe(12345);
  });
});

describe("ensureName on a file database", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join("/tmp/opencode", "atm-names-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists across close/reopen, used_at_ms unchanged", () => {
    const file = path.join(dir, "atm.db");

    const firstDb = openDatabase(file);
    expect(ensureName(firstDb, "SIMON")).toBe(true);
    const usedAt = (firstDb.prepare("SELECT used_at_ms FROM user_names WHERE name = 'SIMON'").get() as { used_at_ms: number }).used_at_ms;
    firstDb.close();

    const secondDb = openDatabase(file);
    expect(ensureName(secondDb, "SIMON")).toBe(false);
    const usedAt2 = (secondDb.prepare("SELECT used_at_ms FROM user_names WHERE name = 'SIMON'").get() as { used_at_ms: number }).used_at_ms;
    expect(usedAt2).toBe(usedAt);
    secondDb.close();
  });
});
```

### Step 2: Run tests to verify they fail
Run: `npx vitest run tests/server/names.test.ts`
Expected: FAIL — module not found

### Step 3: Implement `src/server/names.ts`

```ts
// src/server/names.ts
import type Database from "better-sqlite3";

export function ensureName(db: Database.Database, name: string, nowMs?: number): boolean {
  const timestamp = nowMs ?? Date.now();
  
  const result = db
    .prepare(`INSERT INTO user_names (name, used_at_ms) VALUES (?, ?) ON CONFLICT DO NOTHING`)
    .run(name, timestamp);
  
  return result.changes > 0;
}
```

### Step 4: Run tests to verify they pass
Run: `npx vitest run tests/server/names.test.ts`
Expected: PASS

### Step 5: Commit
```bash
git add src/server/names.ts tests/server/names.test.ts
git commit -m "feat: add persistent name registry"
```

---

## Task 3: Server — Session Middleware (`requireSession.ts`)

**Files:** Create `src/server/http/requireSession.ts`, test via `session-routes.test.ts`

**Interfaces:**
- Consumes: `readSessionId`, `getSession` from `sessions.ts`, `ApiError` from `errors.ts`
- Produces: Express middleware `requireSession`

### Step 1: No standalone test — covered by `session-routes.test.ts` (Task 4)

The middleware is tested indirectly through route tests.

### Step 2: Implement `src/server/http/requireSession.ts`

```ts
// src/server/http/requireSession.ts
import type { Request, Response, NextFunction } from "express";
import { ApiError } from "./errors";
import { readSessionId, getSession } from "../../sessions";

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const sessionId = readSessionId(req.headers.cookie);
  if (!sessionId) {
    throw new ApiError(401, "NOT_AUTHENTICATED", "Session ended. Please log in again.");
  }
  
  const session = getSession(sessionId);
  if (!session) {
    throw new ApiError(401, "NOT_AUTHENTICATED", "Session ended. Please log in again.");
  }
  
  res.locals.session = session;
  next();
}
```

### Step 3: Run tests (in Task 4, `session-routes.test.ts`)
Expected: PASS via route tests

### Step 4: Commit
```bash
git add src/server/http/requireSession.ts
git commit -m "feat: add requireSession middleware"
```

---

## Task 4: Server — Session Routes (`routes/session.ts`)

**Files:** Create `src/server/http/routes/session.ts`, `tests/server/session-routes.test.ts`

**Interfaces:**
- Consumes: `createSession`, `getSession`, `destroySession`, `findSessionByName`, `readSessionId` from `sessions.ts`; `ensureName` from `names.ts`; `recordEvent` from `activity.ts`; `SESSION_COOKIE` from `config.ts`; `ApiError` from `../errors` (note: routes live one level below `http/`); `requireSession` from `../requireSession`; `broadcastActivity` (passed in by `app.ts`)
- Produces: Router with 4 routes

### Step 1: Write failing tests

```ts
// tests/server/session-routes.test.ts
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import request from "supertest";
import { createApp } from "../../src/server/app";
import { openDatabase } from "../../src/server/db";
import { clearSessions, getSession, setSessionSockets, sweepSessions } from "../../src/server/sessions";
import { SESSION_GRACE_MS } from "../../src/server/config";

let db: Database.Database;
let app: ReturnType<typeof createApp>;

// The session store is module-global: without this, a session created by an
// earlier test would still hold its name and every later test would 409.
beforeEach(() => {
  clearSessions();
  db = openDatabase(":memory:");
  app = createApp({ db });
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function cookieHeader(res: request.Response): string | undefined {
  return res.headers["set-cookie"]?.[0]?.split(";")[0];
}

describe("POST /api/session", () => {
  it("new name → 201, Set-Cookie, login row, user_names row", async () => {
    const res = await request(app)
      .post("/api/session")
      .send({ name: "SIMON" })
      .expect(201);
    
    expect(res.body).toEqual({ session: { userName: "SIMON" } });
    expect(cookieHeader(res)).toMatch(/^atm_sid=/);
    
    const loginRows = db.prepare("SELECT * FROM activity_log WHERE event_type = 'login'").all();
    expect(loginRows).toHaveLength(1);
    expect(loginRows[0].user_name).toBe("SIMON");
    
    const nameRows = db.prepare("SELECT * FROM user_names WHERE name = 'SIMON'").all();
    expect(nameRows).toHaveLength(1);
  });

  it("known name after sign-out → 200, new Set-Cookie, new login row, same user_names row", async () => {
    // First login
    const res1 = await request(app).post("/api/session").send({ name: "SIMON" }).expect(201);
    const cookie1 = cookieHeader(res1)!;
    
    // Sign out
    await request(app).delete("/api/session").set("Cookie", cookie1).expect(204);
    
    // Login again
    const res2 = await request(app).post("/api/session").send({ name: "SIMON" }).expect(200);
    expect(res2.body).toEqual({ session: { userName: "SIMON" } });
    expect(cookieHeader(res2)).toMatch(/^atm_sid=/);
    expect(cookieHeader(res2)).not.toBe(cookie1); // new session ID
    
    const loginRows = db.prepare("SELECT * FROM activity_log WHERE event_type = 'login'").all();
    expect(loginRows).toHaveLength(2); // two login entries
    
    const nameRows = db.prepare("SELECT * FROM user_names WHERE name = 'SIMON'").all();
    expect(nameRows).toHaveLength(1); // still one name row
  });

  it("same name after DB reopen → 200, same single user_names row", async () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "atm-routes-test-"));
    try {
      const file = path.join(dir, "atm.db");
      const firstDb = openDatabase(file);
      const firstApp = createApp({ db: firstDb });
      await request(firstApp).post("/api/session").send({ name: "SIMON" }).expect(201);
      firstDb.close();
      clearSessions(); // sessions do not survive a restart

      const secondDb = openDatabase(file);
      const secondApp = createApp({ db: secondDb });
      await request(secondApp).post("/api/session").send({ name: "SIMON" }).expect(200);

      const nameRows = secondDb.prepare("SELECT * FROM user_names WHERE name = 'SIMON'").all();
      expect(nameRows).toHaveLength(1);
      const loginRows = secondDb.prepare("SELECT * FROM activity_log WHERE event_type = 'login'").all();
      expect(loginRows).toHaveLength(2);
      secondDb.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("'AB' and 'user1' → 400 INVALID_NAME, no row written", async () => {
    for (const name of ["AB", "user1", "UsEr1", "A B", ""]) {
      const res = await request(app).post("/api/session").send({ name }).expect(400);
      expect(res.body.error.code).toBe("INVALID_NAME");
    }
    
    const loginRows = db.prepare("SELECT * FROM activity_log WHERE event_type = 'login'").all();
    expect(loginRows).toHaveLength(0);
    const nameRows = db.prepare("SELECT * FROM user_names").all();
    expect(nameRows).toHaveLength(0);
  });
});

describe("GET /api/session", () => {
  it("with valid cookie → 200", async () => {
    const res1 = await request(app).post("/api/session").send({ name: "SIMON" }).expect(201);
    const cookie = cookieHeader(res1)!;
    
    const res2 = await request(app).get("/api/session").set("Cookie", cookie).expect(200);
    expect(res2.body).toEqual({ session: { userName: "SIMON" } });
  });

  it("without cookie → 401 NOT_AUTHENTICATED", async () => {
    const res = await request(app).get("/api/session").expect(401);
    expect(res.body.error.code).toBe("NOT_AUTHENTICATED");
  });
});

describe("GET /api/account is protected", () => {
  it("without cookie → 401", async () => {
    const res = await request(app).get("/api/account").expect(401);
    expect(res.body.error.code).toBe("NOT_AUTHENTICATED");
  });
});

describe("DELETE /api/session", () => {
  it("signs out → 204, cookie cleared, logout row", async () => {
    const res1 = await request(app).post("/api/session").send({ name: "SIMON" }).expect(201);
    const cookie = cookieHeader(res1)!;
    
    const res2 = await request(app).delete("/api/session").set("Cookie", cookie).expect(204);
    
    const clearCookie = res2.headers["set-cookie"]?.[0];
    expect(clearCookie).toMatch(/atm_sid=;/);
    expect(clearCookie).toMatch(/Max-Age=0/);
    
    const logoutRows = db.prepare("SELECT * FROM activity_log WHERE event_type = 'logout'").all();
    expect(logoutRows).toHaveLength(1);
    expect(logoutRows[0].user_name).toBe("SIMON");
  });

  it("second DELETE → 204, still one logout row", async () => {
    const res1 = await request(app).post("/api/session").send({ name: "SIMON" }).expect(201);
    const cookie = cookieHeader(res1)!;
    
    await request(app).delete("/api/session").set("Cookie", cookie).expect(204);
    await request(app).delete("/api/session").set("Cookie", cookie).expect(204);
    
    const logoutRows = db.prepare("SELECT * FROM activity_log WHERE event_type = 'logout'").all();
    expect(logoutRows).toHaveLength(1);
  });
});

describe("In use: another live session holds the name", () => {
  it("A logged in as SIMON; B posts SIMON → 409, no Set-Cookie, no second row, B still 401", async () => {
    // A logs in
    const resA = await request(app).post("/api/session").send({ name: "SIMON" }).expect(201);
    const cookieA = cookieHeader(resA)!;
    
    // B tries same name (no cookie)
    const resB = await request(app).post("/api/session").send({ name: "SIMON" }).expect(409);
    expect(resB.body.error.code).toBe("NAME_TAKEN");
    expect(resB.headers["set-cookie"]).toBeUndefined();
    
    // B's GET /api/session still 401
    await request(app).get("/api/session").expect(401);
    
    // ALEX still available
    await request(app).post("/api/session").send({ name: "ALEX" }).expect(201);
  });
});

describe("Released: sign-out or sweep frees name for reuse", () => {
  it("A signs out, B posts SIMON → 200", async () => {
    const resA = await request(app).post("/api/session").send({ name: "SIMON" }).expect(201);
    const cookieA = cookieHeader(resA)!;
    
    await request(app).delete("/api/session").set("Cookie", cookieA).expect(204);
    
    const resB = await request(app).post("/api/session").send({ name: "SIMON" }).expect(200);
    expect(resB.body).toEqual({ session: { userName: "SIMON" } });
  });

  it("A's sockets drop to 0 + grace expires + sweep → name reusable", async () => {
    const resA = await request(app).post("/api/session").send({ name: "SIMON" }).expect(201);
    const cookieA = cookieHeader(resA)!;
    const sessionId = cookieA!.split("=")[1];

    setSessionSockets(sessionId, 0); // socket closed (tab went away)
    vi.useFakeTimers();
    vi.advanceTimersByTime(SESSION_GRACE_MS + 1);

    const swept = sweepSessions();
    expect(swept.map((s) => s.id)).toEqual([sessionId]);
    expect(getSession(sessionId)).toBeNull();
    // Sweeping writes no logout row — the person never signed out.
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'logout'").get()).toEqual({ n: 0 });

    const resB = await request(app).post("/api/session").send({ name: "SIMON" }).expect(201);
    expect(resB.body).toEqual({ session: { userName: "SIMON" } });
  });
});

describe("Idempotent: same cookie posts same name again", () => {
  it("A posts SIMON again with own cookie → 200, no second login row", async () => {
    const res1 = await request(app).post("/api/session").send({ name: "SIMON" }).expect(201);
    const cookie = cookieHeader(res1)!;
    
    const res2 = await request(app).post("/api/session").send({ name: "SIMON" }).set("Cookie", cookie).expect(200);
    expect(res2.body).toEqual({ session: { userName: "SIMON" } });
    
    const loginRows = db.prepare("SELECT * FROM activity_log WHERE event_type = 'login'").all();
    expect(loginRows).toHaveLength(1);
  });
});

describe("Race: 20 agents post SIMON simultaneously", () => {
  it("one 201, nineteen 409, one login row, one user_names row", async () => {
    const agents = Array.from({ length: 20 }, () => request(app).post("/api/session").send({ name: "SIMON" }));
    const results = await Promise.all(agents.map(p => p));
    
    const statuses = results.map(r => r.status).sort();
    expect(statuses[0]).toBe(201);
    expect(statuses.slice(1)).toEqual(new Array(19).fill(409));
    
    const loginRows = db.prepare("SELECT * FROM activity_log WHERE event_type = 'login'").all();
    expect(loginRows).toHaveLength(1);
    
    const nameRows = db.prepare("SELECT * FROM user_names WHERE name = 'SIMON'").all();
    expect(nameRows).toHaveLength(1);
  });
});

describe("Availability: GET /api/session/availability", () => {
  it("true before login, false while held, true after sign-out; no cookie needed", async () => {
    // Before login
    let res = await request(app).get("/api/session/availability?name=SIMON").expect(200);
    expect(res.body).toEqual({ available: true });
    
    // A logs in
    const resLogin = await request(app).post("/api/session").send({ name: "SIMON" }).expect(201);
    const cookieA = cookieHeader(resLogin)!;
    
    // While held
    res = await request(app).get("/api/session/availability?name=SIMON").expect(200);
    expect(res.body).toEqual({ available: false });
    
    // Sign out
    await request(app).delete("/api/session").set("Cookie", cookieA).expect(204);
    
    // After release
    res = await request(app).get("/api/session/availability?name=SIMON").expect(200);
    expect(res.body).toEqual({ available: true });
  });

  it("writes no log rows", async () => {
    // Only call availability, no login
    await request(app).get("/api/session/availability?name=SIMON").expect(200);
    await request(app).get("/api/session/availability?name=BLAKE").expect(200);
    
    const logRows = db.prepare("SELECT * FROM activity_log").all();
    expect(logRows).toHaveLength(0);
  });

  it("invalid name → 400 INVALID_NAME", async () => {
    const res = await request(app).get("/api/session/availability?name=ab").expect(400);
    expect(res.body.error.code).toBe("INVALID_NAME");
  });
});
```

### Step 2: Run tests to verify they fail
Run: `npx vitest run tests/server/session-routes.test.ts`
Expected: FAIL — module not found

### Step 3: Implement `src/server/http/routes/session.ts`

```ts
// src/server/http/routes/session.ts
import { Router, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import { ApiError } from "../errors";
import { requireSession } from "../requireSession";
import { 
  createSession, getSession, destroySession, readSessionId, findSessionByName 
} from "../../sessions";
import { ensureName } from "../../names";
import { recordEvent } from "../../activity";
import { SESSION_COOKIE } from "../../config";

const NAME_REGEX = /^[A-Z]{3,20}$/;
const COOKIE_MAX_AGE_MS = 1800 * 1000; // spec §3: Max-Age=1800 (30 min)

function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE_MS, // express maxAge is in ms
  });
}

function clearSessionCookie(res: Response): void {
  res.cookie(SESSION_COOKIE, "", {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: 0,
  });
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (!NAME_REGEX.test(trimmed)) {
    throw new ApiError(400, "INVALID_NAME", "Name must be 3 to 20 letters (A-Z).");
  }
  return trimmed;
}

export function createSessionRouter(db: Database.Database, broadcastActivity: () => void): Router {
  const router = Router();

  // POST /api/session — login
  // Deliberately NOT async: Express 4 does not forward rejected promises to
  // errorHandler, so a thrown ApiError must be a synchronous throw.
  router.post("/session", (req: Request, res: Response) => {
    const rawName = req.body?.name;
    if (typeof rawName !== "string") {
      throw new ApiError(400, "INVALID_NAME", "Enter your name.");
    }
    const name = validateName(rawName);

    // Check caller's existing session via cookie
    const callerSessionId = readSessionId(req.headers.cookie);
    const callerSession = callerSessionId ? getSession(callerSessionId) : null;

    if (callerSession) {
      // Caller has a live session
      if (callerSession.userName === name) {
        // Same name — return 200, no new session, no new entry
        return res.status(200).json({ session: { userName: name } });
      }
      // Different name — must sign out first
      throw new ApiError(400, "INVALID_NAME", "Sign out before signing in with another name.");
    }

    // Check if another live session holds this name
    const holder = findSessionByName(name);
    if (holder) {
      throw new ApiError(409, "NAME_TAKEN", "That name is already in use. Try another name.");
    }

    // All checks passed — all side effects in one transaction
    let isNew = false;
    db.transaction(() => {
      isNew = ensureName(db, name);
      recordEvent(db, { eventType: "login", userName: name });
      const session = createSession(name);
      setSessionCookie(res, session.id);
      broadcastActivity();
    })();

    const status = isNew ? 201 : 200;
    res.status(status).json({ session: { userName: name } });
  });

  // GET /api/session/availability — early warning while typing
  router.get("/session/availability", (req: Request, res: Response) => {
    const rawName = req.query.name;
    if (typeof rawName !== "string") {
      throw new ApiError(400, "INVALID_NAME", "Enter your name.");
    }
    const name = validateName(rawName);

    const holder = findSessionByName(name);
    res.json({ available: !holder });
  });

  // GET /api/session — current session (401 handled by requireSession)
  router.get("/session", requireSession, (_req: Request, res: Response) => {
    const session = res.locals.session;
    res.json({ session: { userName: session.userName } });
  });

  // DELETE /api/session — logout
  router.delete("/session", (req: Request, res: Response) => {
    const sessionId = readSessionId(req.headers.cookie);
    if (sessionId) {
      const session = getSession(sessionId);
      if (session) {
        // Sign-out is an event
        db.transaction(() => {
          recordEvent(db, { eventType: "logout", userName: session.userName });
          destroySession(sessionId);
          broadcastActivity();
        })();
      }
      // If session already gone, still 204, no event
    }
    clearSessionCookie(res);
    res.status(204).end();
  });

  return router;
}
```

### Step 4: Run tests to verify they pass
Run: `npx vitest run tests/server/session-routes.test.ts`
Expected: PASS

### Step 5: Commit
```bash
git add src/server/http/routes/session.ts tests/server/session-routes.test.ts
git commit -m "feat: add session routes (login, availability, current, logout)"
```

---

## Task 5: Server — Wire Up App and Sweep Interval

**Files:** Modify `src/server/app.ts`, `src/server/index.ts`

### Step 1: Modify `src/server/app.ts`

The spec requires gating on **every** `/api` route except `/api/health`,
`POST /api/session` and `GET /api/session/availability`. Apply `requireSession`
per-route. Keep `broadcastActivity` optional so existing tests that call
`createApp({ db })` keep working (tests do not need WebSocket broadcasts).

```ts
// src/server/app.ts
import express from "express";
import type Database from "better-sqlite3";
import { createSessionRouter } from "./http/routes/session";
import { requireSession } from "./http/requireSession";
import { getAccount } from "./account";
import { errorHandler, notFoundHandler } from "./http/errors";

export function createApp(deps: {
  db: Database.Database;
  broadcastActivity?: () => void;
}): express.Express {
  const app = express();

  app.use(express.json());

  // Public routes (no session required)
  app.use("/api", createSessionRouter(deps.db, deps.broadcastActivity ?? (() => {})));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // Protected routes (require session)
  app.get("/api/account", requireSession, (_req, res) => {
    res.json({ account: getAccount(deps.db) });
  });

  app.use(express.static("public"));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
```

`createAccountRouter` is no longer used: `/api/health` and `/api/account`
are now handled directly in `app.ts` so the gating is explicit. **Delete**
`src/server/http/routes/account.ts` (and its import) — no dead code.

> Gating rule for later slices: every new `/api` route must be listed either
> in the public section or behind `requireSession`. Never add a route without
> deciding which side it is on.

### Step 1b: Update `tests/server/app.test.ts`

Gating `/api/account` breaks two existing tests. Replace the whole
`describe("GET /api/account")` block with:

```ts
describe("GET /api/account", () => {
  it("401 NOT_AUTHENTICATED without a session cookie", async () => {
    const res = await request(app).get("/api/account");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("NOT_AUTHENTICATED");
  });

  it("returns the shared account when logged in", async () => {
    const login = await request(app).post("/api/session").send({ name: "SIMON" }).expect(201);
    const cookie = login.headers["set-cookie"][0].split(";")[0];

    const res = await request(app).get("/api/account").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.account.balanceCents).toBe(100000);
    expect(res.body.account.balanceFormatted).toBe("$1,000.00");
    expect(typeof res.body.account.updatedAtMs).toBe("number");
  });

  it("returns 500 INTERNAL and no stack when the balance row is gone", async () => {
    const login = await request(app).post("/api/session").send({ name: "SIMON" }).expect(201);
    const cookie = login.headers["set-cookie"][0].split(";")[0];

    db.exec("DELETE FROM account");
    const res = await request(app).get("/api/account").set("Cookie", cookie);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "INTERNAL", message: "Something went wrong." } });
  });
});
```

This test file also needs `clearSessions()` in its `beforeEach` (the session
Map is module-global), same as `session-routes.test.ts`.

Run: `npx vitest run tests/server/app.test.ts` → PASS (only after Task 4's
routes exist; until then the login in these tests 404s).

### Step 2: Modify `src/server/index.ts` to add sweep interval and broadcastActivity

`broadcastActivity` is a no-op placeholder in this slice; slice 05 replaces it
with the real WebSocket broadcast. No `any` — just an empty function.

```ts
// src/server/index.ts
import http from "node:http";
import { openDatabase } from "./db";
import { createApp } from "./app";
import { sweepSessions } from "./sessions";
import { DB_PATH, HOST, LAN_URLS, PORT } from "./config";

const db = openDatabase(DB_PATH);

// Slice 05 replaces this with the real WebSocket broadcast.
function broadcastActivity(): void {}

const app = createApp({ db, broadcastActivity });
const server = http.createServer(app);

// Sweep sessions every 5 seconds
setInterval(() => {
  sweepSessions();
}, 5000);

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other process or set PORT.`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`ATM running on http://localhost:${PORT}`);
  for (const address of LAN_URLS) {
    console.log(`  http://${address}:${PORT}`);
  }
});
```

### Step 3: Run tests to verify they pass
Run: `npm test`
Expected: PASS (all server tests)

### Step 4: Commit
```bash
git add src/server/app.ts src/server/index.ts src/server/http/routes/account.ts tests/server/app.test.ts
git commit -m "feat: wire session routes, protect /api/account, add sweep interval"
```

---

## Task 6: Client — API Module (`api.ts`)

**Files:** Create `src/client/api.ts`

**Interfaces:**
- Consumes: `Account`, `Session` from `shared/types.ts`
- Produces: `HttpError`, `request()`, `login()`, `nameAvailable()`, `currentSession()`, `logout()`, `getAccount()`, `refreshSession()` (no-op stub)

### Step 1: Failing tests for the response shapes (`tests/client/api.test.ts`)

The server wraps payloads; `api.ts` must unwrap them. A wrong shape here is
silent in the browser ("WELCOME, undefined"), so it gets a real test.

```ts
// tests/client/api.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentSession, getAccount, login, logout, HttpError } from "../../src/client/api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fetchMock = () => vi.mocked(globalThis.fetch);

describe("api", () => {
  it("login unwraps { session } and sends credentials", async () => {
    fetchMock().mockResolvedValue(jsonResponse(201, { session: { userName: "SIMON" } }));
    expect(await login("SIMON")).toEqual({ userName: "SIMON" });

    const [, init] = fetchMock().mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.body).toBe(JSON.stringify({ name: "SIMON" }));
  });

  it("currentSession unwraps { session } and returns null on 401", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { session: { userName: "SIMON" } }));
    expect(await currentSession()).toEqual({ userName: "SIMON" });

    fetchMock().mockResolvedValue(jsonResponse(401, { error: { code: "NOT_AUTHENTICATED", message: "nope" } }));
    expect(await currentSession()).toBeNull();
  });

  it("getAccount unwraps { account }", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, {
      account: { balanceCents: 100000, balanceFormatted: "$1,000.00", updatedAtMs: 1 },
    }));
    expect(await getAccount()).toEqual({ balanceCents: 100000, balanceFormatted: "$1,000.00", updatedAtMs: 1 });
  });

  it("maps a thrown fetch to HttpError NETWORK", async () => {
    fetchMock().mockRejectedValue(new TypeError("failed"));
    await expect(logout()).rejects.toMatchObject({ status: 0, code: "NETWORK" });
  });

  it("maps an error body to HttpError with the server's code", async () => {
    fetchMock().mockResolvedValue(jsonResponse(409, {
      error: { code: "NAME_TAKEN", message: "That name is already in use. Try another name." },
    }));
    const err = await login("SIMON").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe("NAME_TAKEN");
    expect((err as HttpError).status).toBe(409);
  });
});
```

Run: `npx vitest run tests/client/api.test.ts`
Expected: FAIL — `src/client/api.ts` not found

### Step 2: Implement `src/client/api.ts`

```ts
// src/client/api.ts
import type { Account, Session } from "../shared/types.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      credentials: "same-origin",
    });
  } catch {
    // fetch throws TypeError on network failure
    throw new HttpError(0, "NETWORK", "Cannot reach the ATM server.");
  }

  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = res.statusText;
    try {
      const body = await res.json();
      code = body.error?.code || code;
      message = body.error?.message || message;
    } catch {
      // non-JSON error body; keep the defaults above
    }
    throw new HttpError(res.status, code, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

// The server wraps payloads: { session: {...} } and { account: {...} }.
// Every caller gets the unwrapped object.
export async function login(name: string): Promise<Session> {
  const body = await request<{ session: Session }>("/api/session", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return body.session;
}

export async function nameAvailable(name: string): Promise<boolean> {
  const res = await request<{ available: boolean }>(`/api/session/availability?name=${encodeURIComponent(name)}`);
  return res.available;
}

export async function currentSession(): Promise<Session | null> {
  try {
    const body = await request<{ session: Session }>("/api/session");
    return body.session;
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      return null;
    }
    throw e;
  }
}

export async function logout(): Promise<void> {
  await request("/api/session", { method: "DELETE" });
}

export async function getAccount(): Promise<Account> {
  const body = await request<{ account: Account }>("/api/account");
  return body.account;
}

// Slice 05 replaces this with a WebSocket re-handshake so the socket picks up
// the new/cleared cookie. No-op in this slice.
export async function refreshSession(): Promise<void> {}
```

### Step 3: Run tests to verify they pass
Run: `npx vitest run tests/client/api.test.ts`
Expected: PASS

### Step 4: Commit
```bash
git add src/client/api.ts tests/client/api.test.ts
git commit -m "feat: add client API module"
```

---

## Task 7: Client — State Updates (`state.ts`)

**Files:** Modify `src/client/state.ts`

### Changes needed:
1. Add `logout` action type
2. Ensure `busy` flag works for in-flight requests
3. Connection state handling
4. `login` action resets the typed input
5. ENTER on the login screen **never** navigates by itself — only the `login` action (dispatched after the server says yes) goes home

### Step 1: Modify `src/client/state.ts`

```ts
// Add to Action type:
export type Action =
  | { type: "key"; key: Key }
  | { type: "screen"; to: ScreenName }
  | { type: "login"; userName: string }
  | { type: "logout" }
  | { type: "busy"; isBusy: boolean }
  | { type: "banner"; message: string | null }
  | { type: "balance"; balanceCents: number }
  | { type: "connection"; status: Connection }
  | { type: "amountMode"; mode: "withdraw" | "deposit" };

// In reduce(), add cases:
export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    // ... existing cases ...

    case "login":
      // Server confirmed: go home with a clean entry (spec §4 "reset input").
      return { ...state, userName: action.userName, screen: "home", input: createMultiTap(), banner: null };

    case "logout": {
      return {
        ...state,
        screen: "login",
        userName: null,
        balanceCents: 0,
        input: createMultiTap(),
        banner: "You are signed out.",
        busy: false,
      };
    }
    
    case "busy": {
      return { ...state, busy: action.isBusy };
    }
    
    case "banner": {
      return { ...state, banner: action.message };
    }
    
    case "balance": {
      return { ...state, balanceCents: action.balanceCents };
    }
    
    case "connection": {
      return { ...state, connection: action.status };
    }

    case "amountMode": {
      return { ...state, screen: "amount", amountMode: action.mode, amountDigits: "" };
    }
  }
  return state;
}
```

**Also change the existing `case "enter"` inside the login branch** so it only
validates length and never jumps to `home` (navigation belongs to `main.ts`
after `POST /api/session` succeeds):

```ts
case "enter": {
  const name = shownText(input).replace(/_$/, "");
  if (name.length < 3) {
    return { ...state, input, banner: "Name must be at least 3 letters." };
  }
  // Valid name: main.ts intercepts ENTER and calls the server.
  // Returning state unchanged keeps the typed name if the request fails.
  return { ...state, input };
}
```

### Step 1b: Update the two tests that asserted ENTER goes home

`tests/client/router.test.ts` — replace `test("enter on login with valid name moves to home")`:

```ts
test("enter on login with valid name waits for the server (stays on login)", () => {
  let state = loginState();
  state.input = { text: "ABC", pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: "key", key: "enter" });
  expect(state.screen).toBe("login");
  expect(state.userName).toBeNull();
  expect(state.input.text).toBe("ABC"); // kept, so a refused name can be edited
});
```

`tests/client/integration.test.ts` — in `full login flow`, replace the ENTER
step with ENTER then the server's confirmation:

```ts
  // Confirm with ENTER: the reducer alone must NOT log in…
  state = reduce(state, { type: "key", key: "enter" });
  expect(state.screen).toBe("login");

  // …only the server's answer (main.ts dispatches this) goes home.
  state = reduce(state, { type: "login", userName: "ABC" });

  expect(state.screen).toBe("home");
  expect(state.userName).toBe("ABC");
  expect(state.banner).toBeNull();
  expect(state.input.text).toBe("");
  expect(state.input.pendingKey).toBeNull();
  expect(homeView(state).title).toBe("WELCOME, ABC");
```

### Step 2: Run tests
Run: `npm test -- tests/client/router.test.ts tests/client/integration.test.ts`
Expected: PASS

### Step 3: Commit
```bash
git add src/client/state.ts tests/client/router.test.ts tests/client/integration.test.ts
git commit -m "feat: add logout, busy, banner, balance, connection actions to reducer"
```

---

## Task 8: Client — Main Entry Point (`main.ts`)

**Files:** Create `src/client/messages.ts`, modify `src/client/main.ts`

This is the **single** implementation of `main.ts` — it owns all async flow
(boot, login, availability, sign out). The screens stay pure view functions.
Do not add a second draft later in Task 9.

### Changes needed:
1. Boot flow: `currentSession()` → home or login
2. Login: ENTER → `login()`, 500ms debounced availability, busy state
3. Sign out: `logout()` → login
4. Handle 401 anywhere → "Session ended. Please log in again."
5. Wire home buttons via `setHomeCallbacks()` (from Task 10)
6. `refreshSession()` comes from `api.ts` (no-op in this slice)
7. **Keepalive:** while on the home screen, `GET /api/session` every 20s, so an
   idle tab doesn't lose its session to the 60s grace sweep (until slice 05's
   socket holds it open)
8. Banner strings live in `messages.ts` — `main.ts` and `screens/login.ts`
   share them (a typo in one place would break the other)

### Step 0: Create `src/client/messages.ts`

```ts
// src/client/messages.ts
// Strings that appear in more than one file. One definition, no drift.
export const MSG_CHECKING = "Checking session…";
export const MSG_SIGNING_IN = "Signing in…";
export const MSG_NAME_TAKEN = "That name is already in use. Try another name.";
export const KEEPALIVE_MS = 20000;
```

### Step 1: Write `src/client/main.ts`

```ts
// src/client/main.ts
import { createInitialState, reduce, AppState, Action, Key } from "./state.js";
import { renderDisplay, ViewModel } from "./ui/display.js";
import { createKeypad } from "./ui/keypad.js";
import { loginView } from "./screens/login.js";
import { homeView, setHomeCallbacks } from "./screens/home.js";
import { amountView } from "./screens/amount.js";
import { messageView } from "./screens/message.js";
import { resolve, shownText } from "./ui/multitap.js";
import {
  currentSession, getAccount, login, logout, nameAvailable,
  refreshSession, HttpError,
} from "./api.js";
import {
  MSG_CHECKING, MSG_SIGNING_IN, MSG_NAME_TAKEN, KEEPALIVE_MS,
} from "./messages.js";

const app = document.getElementById("app")!;
const displayRoot = document.createElement("div");
displayRoot.id = "display";
app.appendChild(displayRoot);

let state = createInitialState();
let availabilityTimer: number | null = null;
let lastAvailabilityName = "";

const keypad = createKeypad((key) => {
  if (state.busy) return;
  handleKey(key);
});
app.appendChild(keypad);

const hint = document.createElement("footer");
hint.className = "atm__hint";
hint.textContent = "Your name is used only in the log.";
app.appendChild(hint);

function getViewModel(appState: AppState): ViewModel {
  switch (appState.screen) {
    case "login": return loginView(appState);
    case "home": return homeView(appState);
    case "amount": return amountView(appState);
    case "message": return messageView(appState);
  }
}

function render() {
  renderDisplay(displayRoot, getViewModel(state));
}

function dispatch(action: Action) {
  state = reduce(state, action);
  render();
}

function handle401() {
  dispatch({ type: "logout" });
  dispatch({ type: "banner", message: "Session ended. Please log in again." });
}

async function loadAccount() {
  try {
    const account = await getAccount();
    dispatch({ type: "balance", balanceCents: account.balanceCents });
    return true;
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      handle401();
    } else {
      // Back to login with a clean state (logout clears userName/input),
      // then say what went wrong.
      dispatch({ type: "logout" });
      dispatch({ type: "banner", message: "Cannot reach the ATM server." });
    }
    return false;
  }
}

async function boot() {
  dispatch({ type: "banner", message: MSG_CHECKING });
  dispatch({ type: "busy", isBusy: true });
  try {
    const session = await currentSession();
    if (session) {
      dispatch({ type: "login", userName: session.userName });
      await loadAccount();
    } else {
      dispatch({ type: "screen", to: "login" });
      dispatch({ type: "banner", message: null });
    }
  } catch (e) {
    if (e instanceof HttpError && e.code === "NETWORK") {
      dispatch({ type: "banner", message: "Cannot reach the ATM server." });
    } else {
      handle401();
    }
    dispatch({ type: "screen", to: "login" });
  } finally {
    dispatch({ type: "busy", isBusy: false });
  }
}

function scheduleAvailabilityCheck() {
  if (availabilityTimer) clearTimeout(availabilityTimer);
  const name = shownText(state.input).replace(/_$/, "");
  if (name.length < 3) {
    if (state.banner === MSG_NAME_TAKEN) {
      dispatch({ type: "banner", message: null });
    }
    return;
  }
  lastAvailabilityName = name;
  availabilityTimer = window.setTimeout(async () => {
    // Ignore stale reply: name must still match the screen
    if (shownText(state.input).replace(/_$/, "") !== lastAvailabilityName) return;
    try {
      const available = await nameAvailable(lastAvailabilityName);
      if (!available) {
        dispatch({ type: "banner", message: MSG_NAME_TAKEN });
      } else if (state.banner === MSG_NAME_TAKEN) {
        dispatch({ type: "banner", message: null });
      }
    } catch {
      // silent on NETWORK — never blocks ENTER
    }
  }, 500);
}

async function handleLoginEnter() {
  const name = shownText(state.input).replace(/_$/, "");
  if (name.length < 3) {
    dispatch({ type: "banner", message: "Name must be at least 3 letters." });
    return;
  }
  if (!/^[A-Z]{3,20}$/.test(name)) {
    dispatch({ type: "banner", message: "Name must be 3 to 20 letters (A-Z)." });
    return;
  }
  dispatch({ type: "busy", isBusy: true });
  dispatch({ type: "banner", message: MSG_SIGNING_IN });
  try {
    const result = await login(name);
    dispatch({ type: "login", userName: result.userName });
    await loadAccount();
    await refreshSession();
  } catch (e) {
    // 409/400: show server message, stay on login, keep typed name
    dispatch({
      type: "banner",
      message: e instanceof HttpError ? e.message : "Cannot reach the ATM server.",
    });
  } finally {
    dispatch({ type: "busy", isBusy: false });
  }
}

async function handleSignOut() {
  dispatch({ type: "busy", isBusy: true });
  try {
    await logout();
    dispatch({ type: "logout" }); // returns to login, banner "You are signed out."
    await refreshSession();
  } catch (e) {
    dispatch({
      type: "banner",
      message: e instanceof HttpError ? e.message : "Cannot reach the ATM server.",
    });
  } finally {
    dispatch({ type: "busy", isBusy: false });
  }
}

function handleKey(key: Key) {
  if (state.screen === "login" && key === "enter") {
    void handleLoginEnter();
    return;
  }
  dispatch({ type: "key", key });
  if (state.screen === "login") scheduleAvailabilityCheck();
}

setHomeCallbacks({
  onWithdraw: () => dispatch({ type: "amountMode", mode: "withdraw" }),
  onDeposit: () => dispatch({ type: "amountMode", mode: "deposit" }),
  onSignOut: () => { void handleSignOut(); },
});

render();
boot();

// Keepalive: the server sweeps sessions silent for SESSION_GRACE_MS (60s).
// Without this, a quiet open tab would be logged out after a minute.
setInterval(() => {
  if (state.screen !== "home" || state.busy) return;
  void currentSession()
    .then((session) => {
      if (!session) handle401();
    })
    .catch(() => {
      // network blip — keepalive never disturbs the screen
    });
}, KEEPALIVE_MS);

// 200ms interval for multi-tap resolution
setInterval(() => {
  const newInput = resolve(state.input, Date.now());
  if (newInput !== state.input) {
    state = { ...state, input: newInput };
    if (state.screen === "login") scheduleAvailabilityCheck();
    render();
  }
}, 200);
```

### Step 2: Run tests
Run: `npm test -- tests/client/router.test.ts`
Expected: PASS (router tests don't test main.ts directly)

### Step 3: Commit
```bash
git add src/client/main.ts src/client/messages.ts
git commit -m "feat: add boot flow, 401 handling, keepalive, shared messages"
```

---

## Task 9: Client — Login Screen (`screens/login.ts`)

**Files:** Modify `src/client/screens/login.ts` (small tweak only)

All login *behaviour* lives in `main.ts` (Task 8). `loginView` is a pure view
function. One small change: transient banners should not render in the red
error style. The strings come from `messages.ts` so they cannot drift.

### Step 1: Update the `status` line in `loginView`

```ts
// src/client/screens/login.ts
import { AppState } from "../state.js";
import { ViewModel } from "../ui/display.js";
import { shownText } from "../ui/multitap.js";
import { MSG_CHECKING, MSG_SIGNING_IN } from "../messages.js";

const TRANSIENT = new Set([MSG_CHECKING, MSG_SIGNING_IN]);

export function loginView(state: AppState): ViewModel {
  return {
    title: "WELCOME",
    lines: ["Enter your name", "Use the keypad. 3 to 20 letters."],
    input: shownText(state.input),
    banner: state.banner,
    status: state.banner && !TRANSIENT.has(state.banner) ? "error" : "info",
  };
}
```

The existing tests in `tests/client/screens.test.ts` keep passing — they only
assert title, lines and input.

### Step 2: Add one test to `tests/client/screens.test.ts`

```ts
test("transient banners render as info, real ones as error", () => {
  expect(loginView(loginState({ banner: "Signing in…" })).status).toBe("info");
  expect(loginView(loginState({ banner: "Checking session…" })).status).toBe("info");
  expect(loginView(loginState({ banner: "That name is already in use. Try another name." })).status).toBe("error");
});
```

(Use the file's existing helper for a login state, or build one with
`{ ...createInitialState(), screen: "login", banner: ... }`.)

Run: `npm test -- tests/client/screens.test.ts`
Expected: PASS

### Step 3: Commit
```bash
git add src/client/screens/login.ts tests/client/screens.test.ts
git commit -m "feat: keep transient login banners in info style"
```

---

---

## Task 10: Client — Home Screen (`screens/home.ts`)

**Files:** Modify `src/client/screens/home.ts`, `src/client/ui/display.ts`, `public/css/atm.css`

### Changes needed:
1. Add three buttons: Withdraw, Deposit, Sign out
2. Buttons in `.atm__actions` under display, inside frame
3. Disabled while `busy` or transaction in progress
4. Stay enabled while someone else holds lock (slice 07)
5. Sign out handler calls main's `handleSignOut` (need to expose it)

Since the screen is a pure view model function, it returns the button config. The display renderer needs to handle actions.

The current `display.ts` renders title, lines, input and banner — extend it to render action buttons.

### Step 1: Modify `src/client/ui/display.ts` to support actions

```ts
// src/client/ui/display.ts
export interface ViewModel {
  title: string;
  lines: string[];
  input?: string;
  banner?: string | null;
  status?: "info" | "success" | "error";
  actions?: ActionViewModel[];
}

export interface ActionViewModel {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

export function renderDisplay(root: HTMLElement, vm: ViewModel): void {
  root.innerHTML = "";

  const screen = document.createElement("div");
  screen.className = "atm__screen";
  screen.setAttribute("aria-live", "polite");

  const title = document.createElement("div");
  title.className = "atm__title";
  title.textContent = vm.title;
  screen.appendChild(title);

  for (const line of vm.lines) {
    const lineEl = document.createElement("div");
    lineEl.className = "atm__line";
    lineEl.textContent = line;
    screen.appendChild(lineEl);
  }

  if (vm.input !== undefined) {
    const input = document.createElement("div");
    input.className = "atm__input";
    input.textContent = vm.input;
    screen.appendChild(input);
  }

  if (vm.banner) {
    const banner = document.createElement("div");
    banner.className = `atm__banner atm__banner--${vm.status || "info"}`;
    banner.textContent = vm.banner;
    screen.appendChild(banner);
  }

  if (vm.actions && vm.actions.length > 0) {
    const actions = document.createElement("div");
    actions.className = "atm__actions";

    for (const action of vm.actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `atm__action ${action.className ?? ""}`.trim();
      btn.textContent = action.label;
      btn.disabled = action.disabled ?? false;
      btn.addEventListener("click", action.onClick);
      actions.appendChild(btn);
    }
    screen.appendChild(actions);
  }

  root.appendChild(screen);
}
```

Styling (hover, disabled, layout) lives in the stylesheet, not in JS.

### Step 1b: Add the rules to `public/css/atm.css`

```css
.atm__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.atm__action {
  flex: 1;
  min-width: 80px;
  padding: 12px;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: filter 100ms;
  background: #2c3e50;
  color: #fff;
}

.atm__action:hover:not(:disabled) { filter: brightness(1.1); }
.atm__action:active:not(:disabled) { filter: brightness(0.92); }

.atm__action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.atm__action:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
```

### Step 2: Modify `src/client/screens/home.ts`

```ts
// src/client/screens/home.ts
import { AppState } from "../state.js";
import { ViewModel, ActionViewModel } from "../ui/display.js";
import { formatCents } from "../ui/money.js";

// main.ts registers these once; the view stays pure.

let onWithdraw: () => void = () => {};
let onDeposit: () => void = () => {};
let onSignOut: () => void = () => {};

export function setHomeCallbacks(callbacks: { onWithdraw: () => void; onDeposit: () => void; onSignOut: () => void }) {
  onWithdraw = callbacks.onWithdraw;
  onDeposit = callbacks.onDeposit;
  onSignOut = callbacks.onSignOut;
}

export function homeView(state: AppState): ViewModel {
  const isBusy = state.busy;
  
  const actions: ActionViewModel[] = [
    {
      label: "Withdraw",
      onClick: onWithdraw,
      disabled: isBusy,
      className: "atm__action--withdraw",
    },
    {
      label: "Deposit",
      onClick: onDeposit,
      disabled: isBusy,
      className: "atm__action--deposit",
    },
    {
      label: "Sign out",
      onClick: onSignOut,
      disabled: isBusy,
      className: "atm__action--signout",
    },
  ];

  return {
    title: `WELCOME, ${state.userName || ""}`,
    lines: ["Balance", formatCents(state.balanceCents)],
    actions,
  };
}
```

The callback wiring is already in `main.ts` (Task 8) and the `amountMode`
action is already in `state.ts` (Task 7). This task only adds the buttons to
the view.

### Step 2b: Tests for the buttons

Add to `tests/client/screens.test.ts`:

```ts
test("home shows Withdraw, Deposit, Sign out — disabled while busy", () => {
  const idle = homeView(homeState({ busy: false }));
  expect(idle.actions?.map((a) => a.label)).toEqual(["Withdraw", "Deposit", "Sign out"]);
  expect(idle.actions?.every((a) => !a.disabled)).toBe(true);

  const busy = homeView(homeState({ busy: true }));
  expect(busy.actions?.every((a) => a.disabled)).toBe(true);
});
```

Add to `tests/client/display.test.ts` (jsdom — proves they are real buttons):

```ts
test("renders real buttons that fire their onClick", () => {
  const root = document.getElementById("root")!;
  let clicks = 0;
  renderDisplay(root, {
    title: "WELCOME, SIMON",
    lines: ["Balance", "$1,000.00"],
    actions: [
      { label: "Sign out", onClick: () => clicks++ },
      { label: "Withdraw", onClick: () => {}, disabled: true },
    ],
  });

  const buttons = root.querySelectorAll<HTMLButtonElement>("button.atm__action");
  expect(buttons).toHaveLength(2);
  expect(root.querySelector(".atm__actions")).not.toBeNull();

  buttons[0].click();
  expect(clicks).toBe(1);

  expect(buttons[1].disabled).toBe(true);
  buttons[1].click();
  expect(clicks).toBe(1); // disabled buttons do nothing
});
```

(Use `createInitialState()` + `screen: "home"` for `homeState` if the helper
does not exist yet in that file.)

### Step 3: Run tests
Run: `npm test -- tests/client/screens.test.ts tests/client/display.test.ts`
Expected: PASS

### Step 4: Commit
```bash
git add src/client/ui/display.ts src/client/screens/home.ts public/css/atm.css tests/client/screens.test.ts tests/client/display.test.ts
git commit -m "feat: add home screen with three action buttons"
```

---

## Task 11: Client — Router Tests Extended (`router.test.ts`)

**Files:** Modify `tests/client/router.test.ts`

### Add tests for new actions:

```ts
// tests/client/router.test.ts (append)

function homeState(overrides: Partial<AppState> = {}): AppState {
  return { ...createInitialState(), screen: "home", userName: "ALICE", balanceCents: 100000, ...overrides };
}

test("logout action returns to login, clears userName and input", () => {
  let state = homeState({ userName: "ALICE", balanceCents: 100000 });
  state = reduce(state, { type: "logout" });
  expect(state.screen).toBe("login");
  expect(state.userName).toBeNull();
  expect(state.input.text).toBe("");
  expect(state.banner).toBe("You are signed out.");
});

test("busy action sets busy flag", () => {
  let state = loginState();
  state = reduce(state, { type: "busy", isBusy: true });
  expect(state.busy).toBe(true);
  state = reduce(state, { type: "busy", isBusy: false });
  expect(state.busy).toBe(false);
});

test("banner action sets banner message", () => {
  let state = loginState();
  state = reduce(state, { type: "banner", message: "Hello" });
  expect(state.banner).toBe("Hello");
  state = reduce(state, { type: "banner", message: null });
  expect(state.banner).toBeNull();
});

test("balance action updates balanceCents", () => {
  let state = homeState({ balanceCents: 100000 });
  state = reduce(state, { type: "balance", balanceCents: 50000 });
  expect(state.balanceCents).toBe(50000);
});

test("connection action updates connection status", () => {
  let state = loginState();
  state = reduce(state, { type: "connection", status: "connected" });
  expect(state.connection).toBe("connected");
});

test("amountMode action transitions to amount screen with mode", () => {
  let state = homeState({ userName: "ALICE", balanceCents: 100000 });
  state = reduce(state, { type: "amountMode", mode: "withdraw" });
  expect(state.screen).toBe("amount");
  expect(state.amountMode).toBe("withdraw");
  expect(state.amountDigits).toBe("");
  
  state = reduce(state, { type: "amountMode", mode: "deposit" });
  expect(state.amountMode).toBe("deposit");
});

// Spec §6 flow tests
test("login success sets userName, clears typed name and banner", () => {
  let state = loginState({
    input: { text: "ALICE", pendingKey: null, pendingIndex: 0, pendingAtMs: null },
    banner: "Signing in…",
  });
  state = reduce(state, { type: "login", userName: "ALICE" });
  expect(state.screen).toBe("home");
  expect(state.userName).toBe("ALICE");
  expect(state.input.text).toBe("");
  expect(state.banner).toBeNull();
});

test("nameTaken: server refusal keeps login screen and typed name", () => {
  let state = loginState({
    input: { text: "ALEX", pendingKey: null, pendingIndex: 0, pendingAtMs: null },
    busy: true,
  });
  // main.ts shows the server's message and never dispatches "login"
  state = reduce(state, { type: "busy", isBusy: false });
  state = reduce(state, { type: "banner", message: "That name is already in use. Try another name." });
  expect(state.screen).toBe("login");
  expect(state.userName).toBeNull();
  expect(state.input.text).toBe("ALEX");
  expect(state.banner).toBe("That name is already in use. Try another name.");
});
```

### Run tests
Run: `npm test -- tests/client/router.test.ts`
Expected: PASS

### Commit
```bash
git add tests/client/router.test.ts
git commit -m "test: extend router tests for new actions"
```

---

## Task 12: Build Verification and Acceptance Criteria

### Step 1: Run build
Run: `npm run build`
Expected: No errors, emits server to `dist/` and client to `public/js/`

### Step 2: Run all tests
Run: `npm test`
Expected: All tests pass (server + client)

### Step 3: Manual verification
Run: `npm start`
Open browser, verify:
- Boot shows "Checking session…" then login screen
- Type 3+ letters → after 500ms shows "That name is already in use" if taken
- ENTER with valid new name → home screen with balance $1,000.00
- Home shows three buttons: Withdraw, Deposit, Sign out
- Buttons disabled while busy
- Sign out → login screen with "You are signed out."
- Reload keeps user on homepage (cookie persists)
- Stay idle on home for 2+ minutes, then reload / click a button → still logged in (20s keepalive beats the 60s sweep)
- Two browsers with different names both show $1,000.00
- Third browser tries taken name → warned while typing, refused on ENTER
- Sign out one user → name reusable immediately
- Close tab → name frees after ~1 minute (SESSION_GRACE_MS)
- Log shows one login per login, one logout per sign-out
- Restart server → browsers get "Session ended" on next request, balance and names survive

### Step 4: Commit
```bash
git add -A
git commit -m "feat: complete slice 04 - login, sessions, homepage"
```

---

## Acceptance Criteria Checklist

- [ ] Two browsers log in with different names; both homepages show `$1,000.00`
- [ ] Second browser tries name while user logged in: after 3rd letter display warns, ENTER refused with same message, name stays editable
- [ ] Sign that user out; second browser (or same) can log in with that name. Close tab instead: name frees itself ~1 minute later
- [ ] Sign out and back in as same name; check log: every row says that name, `select name from user_names` lists it exactly once
- [ ] Reloading keeps user on homepage — no second login screen (including after sitting idle for a few minutes)
- [ ] Signing out in one browser does not sign out the other
- [ ] `sqlite3 data/atm.db "select event_type,user_name,local_time from activity_log"` shows one `login` per login, one `logout` per sign-out, in time order, **no** row for refused attempt
- [ ] 2-letter name refused with readable message, no log row
- [ ] Restarting server sends every browser back to login on next request with `Session ended` banner; balance and names survive; same name can be used again
- [ ] `npm test` passes