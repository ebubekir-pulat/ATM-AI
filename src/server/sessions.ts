import { randomUUID } from "node:crypto";
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
  const id = randomUUID();
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
