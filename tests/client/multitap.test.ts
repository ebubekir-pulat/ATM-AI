import { expect, test } from "vitest";
import {
  MAX_NAME_LENGTH,
  MULTITAP_WINDOW_MS,
  backspace,
  clearAll,
  createMultiTap,
  press,
  resolve,
  shownText,
} from "../../src/client/ui/multitap";

test("single press shows first letter", () => {
  let s = createMultiTap();
  s = press(s, "2", 1000);
  expect(shownText(s)).toBe("A_");
});

test("three rapid presses on 2 gives C", () => {
  let s = createMultiTap();
  s = press(s, "2", 1000);
  s = press(s, "2", 1200);
  s = press(s, "2", 1400);
  expect(shownText(s)).toBe("C_");
});

test("five rapid presses on 7 wraps to P", () => {
  let s = createMultiTap();
  s = press(s, "7", 1000);
  s = press(s, "7", 1100);
  s = press(s, "7", 1200);
  s = press(s, "7", 1300);
  s = press(s, "7", 1400);
  expect(shownText(s)).toBe("P_");
});

test("different key commits pending and starts new", () => {
  let s = createMultiTap();
  s = press(s, "2", 1000);
  s = press(s, "3", 1100);
  expect(shownText(s)).toBe("AD_");
});

test("resolve commits expired pending", () => {
  let s = createMultiTap();
  s = press(s, "2", 1000);
  s = resolve(s, 1000 + MULTITAP_WINDOW_MS + 1);
  expect(shownText(s)).toBe("A_");
  expect(s.pendingKey).toBeNull();
});

test("backspace deletes pending first", () => {
  let s = createMultiTap();
  s = press(s, "2", 1000);
  s = backspace(s);
  expect(shownText(s)).toBe("_");
  expect(s.pendingKey).toBeNull();
});

test("backspace deletes committed when no pending", () => {
  let s = createMultiTap();
  s = press(s, "2", 1000);
  s = press(s, "3", 1100);
  s = backspace(s);
  s = backspace(s);
  expect(shownText(s)).toBe("_");
});

test("clearAll empties everything", () => {
  let s = createMultiTap();
  s = press(s, "2", 1000);
  s = press(s, "3", 1100);
  s = clearAll();
  expect(shownText(s)).toBe("_");
  expect(s.text).toBe("");
  expect(s.pendingKey).toBeNull();
});

test("max length caps input", () => {
  let s = createMultiTap();
  for (let i = 0; i < MAX_NAME_LENGTH; i++) {
    s = press(s, "2", 1000 + i * 100);
    s = press(s, "3", 1000 + i * 100 + 50);
  }
  const before = shownText(s).length;
  s = press(s, "2", 10000);
  expect(shownText(s).length).toBe(before);
});

test("same key after window commits old letter and starts new", () => {
  let s = createMultiTap();
  s = press(s, "2", 1000);
  s = press(s, "2", 1000 + MULTITAP_WINDOW_MS + 100);
  s = press(s, "2", 1000 + 2 * (MULTITAP_WINDOW_MS + 100));
  expect(shownText(s)).toBe("AAA_");
});

test("shownText includes caret underscore", () => {
  expect(shownText(createMultiTap())).toBe("_");
  let s = createMultiTap();
  s = press(s, "2", 1000);
  expect(shownText(s)).toBe("A_");
  s = { text: "US", pendingKey: "2", pendingIndex: 0, pendingAtMs: 1000 };
  expect(shownText(s)).toBe("USA_");
});
