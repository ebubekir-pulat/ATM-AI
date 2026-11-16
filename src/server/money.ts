import { MAX_AMOUNT_DIGITS } from "./config";

const formatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

export function formatAUD(cents: number): string {
  if (cents < 0) {
    throw new RangeError("cents must not be negative");
  }
  return formatter.format(cents / 100);
}

export function digitsToCents(digits: string): number {
  if (!new RegExp(`^\\d{1,${MAX_AMOUNT_DIGITS}}$`).test(digits)) {
    throw new RangeError("amount must be 1 to 7 digits");
  }
  return Number(digits) * 100;
}

export function isValidAmount(digits: string): boolean {
  return new RegExp(`^\\d{1,${MAX_AMOUNT_DIGITS}}$`).test(digits) && Number(digits) > 0;
}
