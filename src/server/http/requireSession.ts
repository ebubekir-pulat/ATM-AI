import type { Request, Response, NextFunction } from "express";
import { ApiError } from "./errors";
import { readSessionId, getSession } from "../sessions";

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
