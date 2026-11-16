import { describe, expect, it } from "vitest";
import { digitsToCents, formatAUD, isValidAmount } from "../../src/server/money";

describe("formatAUD", () => {
  it("formats dollars and cents", () => expect(formatAUD(100000)).toBe("$1,000.00"));
  it("formats one cent", () => expect(formatAUD(1)).toBe("$0.01"));
  it("formats zero", () => expect(formatAUD(0)).toBe("$0.00"));
  it("keeps grouping above one million", () => expect(formatAUD(123456789)).toBe("$1,234,567.89"));
  it("rejects negative cents", () => expect(() => formatAUD(-1)).toThrow());
});

describe("digitsToCents", () => {
  it("treats typed digits as whole dollars", () => expect(digitsToCents("500")).toBe(50000));
  it("converts zero", () => expect(digitsToCents("0")).toBe(0));
  it.each(["", "abc", "1.5", "12345678", "-5", " 5"])("throws on %s", (input) => {
    expect(() => digitsToCents(input)).toThrow();
  });
});

describe("isValidAmount", () => {
  it.each(["1", "500", "1234567"])("accepts %s", (digits) => {
    expect(isValidAmount(digits)).toBe(true);
  });
  it.each(["0", "", "12345678", "1.5", "abc"])("rejects %s", (digits) => {
    expect(isValidAmount(digits)).toBe(false);
  });
  it("accepts leading zeros because the spec only counts digits", () => {
    expect(isValidAmount("007")).toBe(true);
  });
});
