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
      const res = await request(secondApp).post("/api/session").send({ name: "SIMON" }).expect(200);
      expect(res.body).toEqual({ session: { userName: "SIMON" } });

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
  it("without cookie → 401 NOT_AUTHENTICATED", async () => {
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
  it("A logged in as SIMON; B posts SIMON → 409, no Set-Cookie, B still 401", async () => {
    // A logs in
    const resA = await request(app).post("/api/session").send({ name: "SIMON" }).expect(201);
    const cookieA = cookieHeader(resA)!;

    // B tries same name (no cookie)
    const resB = await request(app).post("/api/session").send({ name: "SIMON" }).expect(409);
    expect(resB.body.error.code).toBe("NAME_TAKEN");
    expect(resB.headers["set-cookie"]).toBeUndefined();

    // B's GET /api/session still 401
    await request(app).get("/api/session").expect(401);

    // JASPER still available
    await request(app).post("/api/session").send({ name: "JASPER" }).expect(201);
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

    const resB = await request(app).post("/api/session").send({ name: "SIMON" }).expect(200);
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
    await request(app).get("/api/session/availability?name=ALICE").expect(200);

    const logRows = db.prepare("SELECT * FROM activity_log").all();
    expect(logRows).toHaveLength(0);
  });

  it("invalid name → 400 INVALID_NAME", async () => {
    const res = await request(app).get("/api/session/availability?name=ab").expect(400);
    expect(res.body.error.code).toBe("INVALID_NAME");
  });
});
