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
