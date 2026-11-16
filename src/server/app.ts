import express from "express";
import type Database from "better-sqlite3";
import { createAccountRouter } from "./http/routes/account";
import { errorHandler, notFoundHandler } from "./http/errors";

export function createApp(deps: { db: Database.Database }): express.Express {
  const app = express();

  app.use(express.json());
  app.use("/api", createAccountRouter(deps.db));
  app.use(express.static("public"));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
