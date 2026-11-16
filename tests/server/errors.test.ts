import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ApiError, errorHandler, notFoundHandler } from "../../src/server/http/errors";

describe("ApiError", () => {
  it("carries a status, a code and a person-readable message", () => {
    const error = new ApiError(409, "NAME_TAKEN", "That name is already in use.");
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(409);
    expect(error.code).toBe("NAME_TAKEN");
    expect(error.message).toBe("That name is already in use.");
  });
});

describe("errorHandler", () => {
  it("returns an ApiError with its status and 01 §6.1 shape", async () => {
    const app = express();
    app.get("/boom", () => {
      throw new ApiError(409, "NAME_TAKEN", "That name is already in use.");
    });
    app.use(errorHandler);

    const res = await request(app).get("/boom");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: "NAME_TAKEN", message: "That name is already in use." },
    });
  });

  it("turns an unknown error into 500 INTERNAL without leaking the stack", async () => {
    const app = express();
    app.get("/boom", () => {
      throw new Error("database is on fire");
    });
    app.use(errorHandler);

    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "INTERNAL", message: "Something went wrong." } });
    expect(JSON.stringify(res.body)).not.toContain("on fire");
  });
});

describe("notFoundHandler", () => {
  it("answers an unknown route with the error shape", async () => {
    const app = express();
    app.use(notFoundHandler);

    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found." } });
  });
});
