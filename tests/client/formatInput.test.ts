import { expect, test } from "vitest";
import { formatCents } from "../../src/client/ui/money";

test("formats cents to dollars with commas and two decimals", () => {
  expect(formatCents(0)).toBe("$0.00");
  expect(formatCents(1)).toBe("$0.01");
  expect(formatCents(99)).toBe("$0.99");
  expect(formatCents(100)).toBe("$1.00");
  expect(formatCents(123456)).toBe("$1,234.56");
  expect(formatCents(1000000)).toBe("$10,000.00");
});
