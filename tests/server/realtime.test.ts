import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import request from "supertest";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { createApp } from "../../src/server/app";
import { openDatabase } from "../../src/server/db";
import { getAccount } from "../../src/server/account";
import { clearSessions, sweepSessions } from "../../src/server/sessions";
import { SESSION_GRACE_MS } from "../../src/server/config";
import { attachRealtime } from "../../src/server/realtime";
import type { Account, ActivityEntry, LockState } from "../../src/shared/types";

// A held lock as the slice-07 LockManager will report it. Until then the
// realtime module takes the lock reader as a dependency.
let heldLock: { ownerSessionId: string; ownerName: string; expiresAtMs: number } | null = null;

function lockStateFor(sessionId: string | null): LockState {
  if (!heldLock) {
    return { locked: false, ownerName: null, isMine: false, expiresAtMs: null };
  }
  return {
    locked: true,
    ownerName: heldLock.ownerName,
    isMine: sessionId === heldLock.ownerSessionId,
    expiresAtMs: heldLock.expiresAtMs,
  };
}

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let server: http.Server;
let io: ReturnType<typeof attachRealtime>;
let port: number;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  clearSessions();
  heldLock = null;
  db = openDatabase(":memory:");
  app = createApp({ db });
  server = http.createServer(app);
  io = attachRealtime(server, { db, lockStateFor });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
  await new Promise<void>((resolve) => io.close(() => resolve()));
  db.close();
  vi.useRealTimers();
});

function connect(cookie?: string): ClientSocket {
  const socket = connectClient(`http://127.0.0.1:${port}`, {
    transports: ["polling"],
    forceNew: true,
    reconnection: false,
    extraHeaders: cookie ? { Cookie: cookie } : undefined,
  });
  clients.push(socket);
  return socket;
}

function once<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 2000);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function login(name: string): Promise<{ cookie: string; sessionId: string }> {
  const res = await request(app).post("/api/session").send({ name }).expect(201);
  const cookie = res.headers["set-cookie"][0].split(";")[0];
  return { cookie, sessionId: cookie.replace("atm_sid=", "") };
}

describe("realtime broadcasts", () => {
  it("sends the current account and lock to a socket with no cookie", async () => {
    const socket = connect();
    const accountPromise = once<{ account: Account }>(socket, "account:updated");
    const lockPromise = once<{ lock: LockState }>(socket, "lock:updated");
    await once(socket, "connect");

    const { account } = await accountPromise;
    expect(account.balanceCents).toBe(100000);
    expect((await lockPromise).lock.ownerName).toBeNull();
  });

  it("broadcasts a login activity entry", async () => {
    const socket = connect();
    const activityPromise = once<{ entry: ActivityEntry }>(socket, "activity:created");
    await once(socket, "connect");

    await login("SIMON");

    const { entry } = await activityPromise;
    expect(entry.eventType).toBe("login");
    expect(entry.userName).toBe("SIMON");
  });

  it("broadcasts a committed balance change", async () => {
    const socket = connect();
    await once(socket, "connect");

    const updated = once<{ account: Account }>(socket, "account:updated");
    db.prepare("UPDATE account SET balance_cents = ? WHERE id = 1").run(250000);
    const { broadcastAccount } = await import("../../src/server/realtime");
    broadcastAccount(getAccount(db));

    expect((await updated).account.balanceCents).toBe(250000);
  });

  it("marks the lock as mine only for the owning session", async () => {
    const { cookie, sessionId } = await login("SIMON");
    const anonymous = connect();
    const loggedIn = connect(cookie);
    await Promise.all([once(anonymous, "connect"), once(loggedIn, "connect")]);

    heldLock = { ownerSessionId: sessionId, ownerName: "SIMON", expiresAtMs: Date.now() + 30000 };
    const anonymousLock = once<{ lock: LockState }>(anonymous, "lock:updated");
    const loggedInLock = once<{ lock: LockState }>(loggedIn, "lock:updated");
    const { broadcastLockState } = await import("../../src/server/realtime");
    broadcastLockState();

    const mine = (await loggedInLock).lock;
    const theirs = (await anonymousLock).lock;
    expect(mine.isMine).toBe(true);
    expect(theirs.isMine).toBe(false);
    expect(theirs.ownerName).toBe("SIMON");
  });

  it("accepts a malformed cookie and reports no lock ownership", async () => {
    const socket = connect("atm_sid=not-a-session");
    const lockPromise = once<{ lock: LockState }>(socket, "lock:updated");
    await once(socket, "connect");

    const { lock } = await lockPromise;
    expect(lock.locked).toBe(false);
    expect(lock.isMine).toBe(false);
  });

  it("disconnects the client when the server closes", async () => {
    const socket = connect();
    await once(socket, "connect");
    const disconnected = once(socket, "disconnect");

    io.close();

    await expect(disconnected).resolves.toBeDefined();
  });

  it("keeps a session alive while a socket is connected, then lets it expire", async () => {
    const { cookie, sessionId } = await login("SIMON");
    const socket = connect(cookie);
    await once(socket, "connect");

    await request(app).get("/api/session").set("Cookie", cookie).expect(200);

    socket.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The server removes the socket from its namespace map before emitting
    // `disconnect`, so an empty map means the disconnect handler has run.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SESSION_GRACE_MS + 1000);
    const swept = sweepSessions();
    vi.useRealTimers();

    expect(swept.map((session) => session.id)).toContain(sessionId);
    await request(app).get("/api/session").set("Cookie", cookie).expect(401);
  });
});
