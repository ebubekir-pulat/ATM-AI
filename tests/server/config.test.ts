import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PORT;
  delete process.env.INITIAL_BALANCE_CENTS;
});

describe("config", () => {
  it("uses the documented defaults", async () => {
    const config = await import("../../src/server/config");
    expect(config.PORT).toBe(3000);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.DB_PATH).toBe("data/atm.db");
    expect(config.INITIAL_BALANCE_CENTS).toBe(100000);
    expect(config.MAX_DEPOSIT_CENTS).toBe(1000000);
    expect(config.MAX_AMOUNT_DIGITS).toBe(7);
    expect(config.MIN_NAME_LENGTH).toBe(3);
    expect(config.MAX_NAME_LENGTH).toBe(20);
    expect(config.MULTITAP_WINDOW_MS).toBe(800);
    expect(config.LOCK_LEASE_MS).toBe(30000);
    expect(config.LOCK_RENEW_MS).toBe(10000);
    expect(config.AI_CONTEXT_LIMIT).toBe(50);
    expect(config.AI_TIMEOUT_MS).toBe(20000);
    expect(config.OLLAMA_URL).toBe("http://127.0.0.1:11434");
    expect(config.OLLAMA_MODEL).toBe("llama3.2:3b");
    expect(config.SESSION_COOKIE).toBe("atm_sid");
    expect(config.SESSION_GRACE_MS).toBe(60000);
  });

  it("reads overrides from the environment", async () => {
    process.env.PORT = "4000";
    process.env.INITIAL_BALANCE_CENTS = "250";
    const config = await import("../../src/server/config");
    expect(config.PORT).toBe(4000);
    expect(config.INITIAL_BALANCE_CENTS).toBe(250);
  });

  it("lists only non-internal IPv4 LAN addresses", async () => {
    const { LAN_URLS } = await import("../../src/server/config");
    expect(Array.isArray(LAN_URLS)).toBe(true);
    for (const address of LAN_URLS) {
      expect(address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
      expect(address).not.toBe("127.0.0.1");
    }
  });
});
