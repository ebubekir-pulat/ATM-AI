import { expect, test } from "vitest";
import { AppState, createInitialState, reduce } from "../../src/client/state";
import { createMultiTap } from "../../src/client/ui/multitap";

function loginState(overrides: Partial<AppState> = {}): AppState {
  return { ...createInitialState(), screen: "login", ...overrides };
}

function amountState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...createInitialState(),
    screen: "amount",
    amountMode: "withdraw",
    balanceCents: 100000,
    ...overrides,
  };
}

test("digit on login appends through multi-tap", () => {
  let state = loginState();
  state = reduce(state, { type: "key", key: "2" });
  state = reduce(state, { type: "key", key: "2" });
  state = reduce(state, { type: "key", key: "2" });
  expect(state.input.text).toBe("");
  expect(state.input.pendingKey).toBe("2");
  expect(state.input.pendingIndex).toBe(2); // C
});

test("back on login deletes one character, does not leave screen", () => {
  let state = loginState();
  state.input = { text: "ABC", pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: "key", key: "back" });
  expect(state.input.text).toBe("AB");
  expect(state.screen).toBe("login");
});

test("back on amount deletes digit; empty returns home", () => {
  let state = amountState({ amountDigits: "100" });
  state = reduce(state, { type: "key", key: "back" });
  expect(state.amountDigits).toBe("10");

  state = reduce(state, { type: "key", key: "back" });
  expect(state.amountDigits).toBe("1");
  state = reduce(state, { type: "key", key: "back" });
  expect(state.amountDigits).toBe("");
  expect(state.screen).toBe("amount");

  state = reduce(state, { type: "key", key: "back" });
  expect(state.screen).toBe("home");
  expect(state.amountMode).toBeNull();
  expect(state.amountDigits).toBe("");
});

test("enter on login with < 3 chars shows banner and stays", () => {
  let state = loginState();
  state.input = { text: "AB", pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: "key", key: "enter" });
  expect(state.screen).toBe("login");
  expect(state.banner).toBe("Name must be at least 3 letters.");
});

test("enter on login with valid name moves to home", () => {
  let state = loginState();
  state.input = { text: "ABC", pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: "key", key: "enter" });
  expect(state.screen).toBe("home");
  expect(state.userName).toBe("ABC");
  expect(state.banner).toBeNull();
});

test("clear on login empties entry", () => {
  let state = loginState({
    input: { text: "HELLO", pendingKey: null, pendingIndex: 0, pendingAtMs: null },
  });
  state = reduce(state, { type: "key", key: "clear" });
  expect(state.input.text).toBe("");
  expect(state.input.pendingKey).toBeNull();
});

test("digit on amount appends to amountDigits", () => {
  let state = amountState({ amountDigits: "" });
  state = reduce(state, { type: "key", key: "5" });
  state = reduce(state, { type: "key", key: "0" });
  expect(state.amountDigits).toBe("50");
});

test("clear on amount empties amountDigits", () => {
  let state = amountState({ amountDigits: "123" });
  state = reduce(state, { type: "key", key: "clear" });
  expect(state.amountDigits).toBe("");
});

test("login action sets userName and moves to home", () => {
  let state = loginState({ banner: "Name must be at least 3 letters." });
  state = reduce(state, { type: "login", userName: "ALICE" });
  expect(state.screen).toBe("home");
  expect(state.userName).toBe("ALICE");
  expect(state.banner).toBeNull();
});
