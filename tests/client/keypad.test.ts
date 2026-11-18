// @vitest-environment jsdom
import { expect, test } from "vitest";
import { createKeypad } from "../../src/client/ui/keypad";

test("creates keypad with 12 keys + enter, calls onKey on click", () => {
  const keys: string[] = [];
  const keypad = createKeypad((k) => keys.push(k));
  document.body.appendChild(keypad);

  const buttons = keypad.querySelectorAll("button");
  expect(buttons.length).toBe(13); // 12 + enter

  // Check layout order: 1 2 3 / 4 5 6 / 7 8 9 / clear 0 back
  const labels = Array.from(buttons)
    .slice(0, 12)
    .map((b) => b.textContent?.trim());
  expect(labels).toEqual([
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "CLEAR", "0", "BACK",
  ]);

  // Enter is separate row, spans 3 columns
  const enterBtn = buttons[12];
  expect(enterBtn.textContent?.trim()).toBe("ENTER");
  expect(enterBtn.getAttribute("style")?.includes("grid-column")).toBeTruthy();

  // Click a digit
  (buttons[0] as HTMLButtonElement).click();
  expect(keys).toEqual(["1"]);

  // Click clear
  (buttons[9] as HTMLButtonElement).click();
  expect(keys).toEqual(["1", "clear"]);

  // Aria labels
  expect(buttons[9].getAttribute("aria-label")).toBe("Clear entry");
  expect(buttons[11].getAttribute("aria-label")).toBe(
    "Delete last character",
  );
  expect(enterBtn.getAttribute("aria-label")).toBe("Enter and confirm");
});

test("colours: digits grey, clear yellow, back red, enter green", () => {
  const keypad = createKeypad(() => {});
  const buttons = keypad.querySelectorAll("button");

  // Digits (first 9) - grey
  for (let i = 0; i < 9; i++) {
    expect(buttons[i].getAttribute("style")).toContain("#d8dde3");
  }
  // Clear (index 9) - yellow
  expect(buttons[9].getAttribute("style")).toContain("#f2c744");
  // 0 (index 10) - grey
  expect(buttons[10].getAttribute("style")).toContain("#d8dde3");
  // Back (index 11) - red
  expect(buttons[11].getAttribute("style")).toContain("#c0392b");
  // Enter (index 12) - green
  expect(buttons[12].getAttribute("style")).toContain("#27ae60");
});
