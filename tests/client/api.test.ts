import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentSession, getAccount, login, logout, HttpError } from "../../src/client/api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fetchMock = () => vi.mocked(globalThis.fetch);

describe("api", () => {
  it("login unwraps { session } and sends credentials", async () => {
    fetchMock().mockResolvedValue(jsonResponse(201, { session: { userName: "SIMON" } }));
    expect(await login("SIMON")).toEqual({ userName: "SIMON" });

    const [, init] = fetchMock().mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.body).toBe(JSON.stringify({ name: "SIMON" }));
  });

  it("currentSession unwraps { session } and returns null on 401", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { session: { userName: "SIMON" } }));
    expect(await currentSession()).toEqual({ userName: "SIMON" });

    fetchMock().mockResolvedValue(jsonResponse(401, { error: { code: "NOT_AUTHENTICATED", message: "nope" } }));
    expect(await currentSession()).toBeNull();
  });

  it("getAccount unwraps { account }", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, {
      account: { balanceCents: 100000, balanceFormatted: "$1,000.00", updatedAtMs: 1 },
    }));
    expect(await getAccount()).toEqual({ balanceCents: 100000, balanceFormatted: "$1,000.00", updatedAtMs: 1 });
  });

  it("maps a thrown fetch to HttpError NETWORK", async () => {
    fetchMock().mockRejectedValue(new TypeError("failed"));
    await expect(logout()).rejects.toMatchObject({ status: 0, code: "NETWORK" });
  });

  it("maps an error body to HttpError with the server's code", async () => {
    fetchMock().mockResolvedValue(jsonResponse(409, {
      error: { code: "NAME_TAKEN", message: "That name is already in use. Try another name." },
    }));
    const err = await login("SIMON").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe("NAME_TAKEN");
    expect((err as HttpError).status).toBe(409);
  });
});
