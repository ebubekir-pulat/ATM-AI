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
    const a = createSession("USER1");
    const b = createSession("USER2");
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("getSession round-trips", () => {
  it("returns session and updates lastSeenMs", () => {
    const s = createSession("USER1");
    const before = s.lastSeenMs;
    // Small delay to ensure timestamp changes
    const got = getSession(s.id);
    expect(got).not.toBeNull();
    expect(got!.lastSeenMs).toBeGreaterThanOrEqual(before);
    expect(got!.userName).toBe("USER1");
  });

  it("returns null for destroyed session", () => {
    const s = createSession("USER1");
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
    const s = createSession("USER1");
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
    const s = createSession("USER1");
    const id = s.id;
    setSessionSockets(id, 0);

    // Fast-forward past grace
    vi.useFakeTimers();
    vi.advanceTimersByTime(SESSION_GRACE_MS + 1);

    expect(getSession(id)).toBeNull();
    vi.useRealTimers();
  });

  it("session within grace is alive", () => {
    const s = createSession("USER1");
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

    const s = createSession("USER1");
    destroySession(s.id);
    expect(() => setSessionSockets(s.id, 0)).not.toThrow();
  });
});

describe("findSessionByName applies liveness", () => {
  it("returns holder if session live", () => {
    const s = createSession("USER1");
    expect(findSessionByName("USER1")?.id).toBe(s.id);
  });

  it("returns null if session gone (past grace)", () => {
    const s = createSession("USER1");
    const id = s.id;
    setSessionSockets(id, 0);

    vi.useFakeTimers();
    vi.advanceTimersByTime(SESSION_GRACE_MS + 1);

    expect(findSessionByName("USER1")).toBeNull();
    vi.useRealTimers();
  });

  it("exact match only (USER1 ≠ USER10)", () => {
    createSession("USER1");
    expect(findSessionByName("USER10")).toBeNull();
  });
});

describe("sweepSessions", () => {
  it("destroys only sessions past grace, returns them", () => {
    const a = createSession("USER1");
    const b = createSession("USER2");
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

  it("sweeps a session whose tab closed after its last request cleared the clock", () => {
    const s = createSession("USER1");
    const id = s.id;

    // A request proves presence and clears the absence clock (keepalive).
    expect(getSession(id)).not.toBeNull();
    expect(s.absentSinceMs).toBeNull();

    vi.useFakeTimers();
    vi.advanceTimersByTime(SESSION_GRACE_MS + 1);

    expect(sweepSessions()).toHaveLength(1);
    expect(getSession(id)).toBeNull();
    vi.useRealTimers();
  });
});
