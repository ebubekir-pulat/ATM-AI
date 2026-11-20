import { Router, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import { ApiError } from "../errors";
import { requireSession } from "../requireSession";
import { createSession, getSession, destroySession, readSessionId, findSessionByName } from "../../sessions";
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
