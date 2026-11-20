import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { expect, test } from "vitest";
import { createInitialState, reduce } from "../../src/client/state";
import type { MultiTapState } from "../../src/client/state";
import { amountView, homeView, loginView } from "../../src/client/screens";
import { formatCents } from "../../src/client/ui/money";
import {
  createMultiTap,
  MULTITAP_WINDOW_MS,
  press,
  resolve,
  shownText,
} from "../../src/client/ui/multitap";

// Type a name on key "2" through the multi-tap engine, one committed letter at
// a time. Each entry gives the number of taps for that letter (1=A, 2=B, 3=C),
// and resolve() commits it by letting the multi-tap window expire. Using
// explicit timestamps keeps the test deterministic (no dependence on real time).
function typeOnKey2(tapsPerLetter: number[]): MultiTapState {
  let input = createMultiTap();
  let now = 0;
  for (const taps of tapsPerLetter) {
    for (let i = 0; i < taps; i++) {
      input = press(input, "2", now);
      now += 100;
    }
    input = resolve(input, now + MULTITAP_WINDOW_MS);
    now += MULTITAP_WINDOW_MS + 200;
  }
  return input;
}

test("full login flow: multi-tap ABC -> enter -> home", () => {
  let state = createInitialState();

  // Build a fully committed "ABC" through the multi-tap engine.
  const input = typeOnKey2([1, 2, 3]);
  expect(shownText(input)).toBe("ABC_");
  state.input = input;

  // Confirm with ENTER: the reducer alone must NOT log in…
  state = reduce(state, { type: "key", key: "enter" });
  expect(state.screen).toBe("login");

  // …only the server's answer (main.ts dispatches this) goes home.
  state = reduce(state, { type: "login", userName: "ABC" });

  expect(state.screen).toBe("home");
  expect(state.userName).toBe("ABC");
  expect(state.banner).toBeNull();
  expect(state.input.text).toBe("");
  expect(state.input.pendingKey).toBeNull();
  expect(homeView(state).title).toBe("WELCOME, ABC");
});

test("multi-tap: 2 three times slowly = AAA", () => {
  let s = createMultiTap();
  const base = 0;
  s = press(s, "2", base);
  s = press(s, "2", base + MULTITAP_WINDOW_MS + 100); // expired
  s = press(s, "2", base + 2 * (MULTITAP_WINDOW_MS + 100));
  expect(shownText(s)).toBe("AAA_");
});

test("multi-tap: 7 five times quickly = P (wrap)", () => {
  let s = createMultiTap();
  const base = 0;
  for (let i = 0; i < 5; i++) {
    s = press(s, "7", base + i * 100);
  }
  expect(shownText(s)).toBe("P_");
});

test("CLEAR empties entry", () => {
  let state = createInitialState();
  state = reduce(state, { type: "key", key: "2" });
  state = reduce(state, { type: "key", key: "2" });
  state = reduce(state, { type: "key", key: "clear" });
  expect(state.input.text).toBe("");
  expect(state.input.pendingKey).toBeNull();
});

test("BACK removes one character", () => {
  let state = createInitialState();
  state.input = { text: "ABC", pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: "key", key: "back" });
  expect(state.input.text).toBe("AB");
  expect(state.screen).toBe("login");
});

test("ENTER with AB shows error banner", () => {
  let state = createInitialState();
  state.input = { text: "AB", pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: "key", key: "enter" });
  expect(state.screen).toBe("login");
  expect(state.banner).toBe("Name must be at least 3 letters.");
  expect(loginView(state).banner).toBe("Name must be at least 3 letters.");
});

test("ENTER with ABC waits for the server and only the login action goes home", () => {
  let state = createInitialState();
  state.input = { text: "ABC", pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: "key", key: "enter" });
  expect(state.screen).toBe("login");
  expect(state.userName).toBeNull();
  expect(state.banner).toBeNull();

  state = reduce(state, { type: "login", userName: "ABC" });
  expect(state.screen).toBe("home");
  expect(state.userName).toBe("ABC");
  expect(homeView(state).title).toBe("WELCOME, ABC");
});

test("BACK on amount deletes digit, empty returns home", () => {
  let state = createInitialState();
  state.screen = "amount";
  state.amountMode = "withdraw";
  state.amountDigits = "100";

  state = reduce(state, { type: "key", key: "back" });
  expect(state.amountDigits).toBe("10");
  expect(amountView(state).input).toBe("10_");

  state = reduce(state, { type: "key", key: "back" });
  expect(state.amountDigits).toBe("1");

  state = reduce(state, { type: "key", key: "back" });
  expect(state.amountDigits).toBe("");
  expect(state.screen).toBe("amount");

  // One more BACK on an empty amount cancels back to home.
  state = reduce(state, { type: "key", key: "back" });
  expect(state.screen).toBe("home");
  expect(state.amountMode).toBeNull();
});

test("formatCents matches server Intl formatting", () => {
  expect(formatCents(0)).toBe("$0.00");
  expect(formatCents(123456)).toBe("$1,234.56");
});

test("ATM fits 375px viewport", () => {
  // The ATM caps its width below 375px and keeps keys thumb-sized (spec §2/§8).
  const css = readFileSync(pathResolve(process.cwd(), "public/css/atm.css"), "utf8");
  expect(css).toMatch(/max-width:\s*420px/);
  expect(css).toMatch(/min-height:\s*56px/);
});
