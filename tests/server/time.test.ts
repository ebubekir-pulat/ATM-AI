import { describe, expect, it } from "vitest";
import { formatLocalDateTime, localStamp } from "../../src/server/time";

const KNOWN_MS = 1763200000000;

describe("localStamp", () => {
  it("keeps the timestamp it was given", () => {
    expect(localStamp(KNOWN_MS).timestampMs).toBe(KNOWN_MS);
  });

  it("produces a zero-padded local date and 24-hour time", () => {
    const stamp = localStamp(KNOWN_MS);
    expect(stamp.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(stamp.localTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("defaults to now", () => {
    const before = Date.now();
    expect(localStamp().timestampMs).toBeGreaterThanOrEqual(before);
  });

  it("formats date and time together", () => {
    const stamp = localStamp(KNOWN_MS);
    expect(formatLocalDateTime(KNOWN_MS)).toBe(`${stamp.localDate} ${stamp.localTime}`);
  });
});
