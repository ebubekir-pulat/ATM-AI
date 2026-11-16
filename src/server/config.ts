import os from "node:os";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    if (!interfaces) {
      continue;
    }
    for (const net of interfaces) {
      if (net && net.family === "IPv4" && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

export const PORT = intEnv("PORT", 3000);
export const HOST = process.env.HOST ?? "0.0.0.0";
export const DB_PATH = process.env.DB_PATH ?? "data/atm.db";
export const INITIAL_BALANCE_CENTS = intEnv("INITIAL_BALANCE_CENTS", 100000);
export const MAX_DEPOSIT_CENTS = 1000000;
export const MAX_AMOUNT_DIGITS = 7;
export const MIN_NAME_LENGTH = 3;
export const MAX_NAME_LENGTH = 20;
export const MULTITAP_WINDOW_MS = 800;
export const LOCK_LEASE_MS = intEnv("LOCK_LEASE_MS", 30000);
export const LOCK_RENEW_MS = 10000;
export const AI_CONTEXT_LIMIT = 50;
export const AI_TIMEOUT_MS = 20000;
export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:3b";
export const SESSION_COOKIE = "atm_sid";
export const SESSION_GRACE_MS = 60000;
export const LAN_URLS: string[] = lanAddresses();
