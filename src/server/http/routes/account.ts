import { Router } from "express";
import type Database from "better-sqlite3";
import { getAccount } from "../../account";

export function createAccountRouter(db: Database.Database): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  router.get("/account", (_req, res) => {
    res.json({ account: getAccount(db) });
  });

  return router;
}
