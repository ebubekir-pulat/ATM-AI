import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/server/http/errors";

describe("ApiError", () => {
  it("carries a status, a code and a person-readable message", () => {
    const error = new ApiError(409, "NAME_TAKEN", "That name is already in use.");
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(409);
    expect(error.code).toBe("NAME_TAKEN");
    expect(error.message).toBe("That name is already in use.");
  });
});
