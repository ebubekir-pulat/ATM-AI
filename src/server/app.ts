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
