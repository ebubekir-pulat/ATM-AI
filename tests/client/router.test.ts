import { expect, test } from "vitest";
import { AppState, createInitialState, MULTITAP_WINDOW_MS, reduce } from "../../src/client/state";

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

test("enter on short name keeps the resolved input when a pending letter expires", () => {
  let state = loginState();
  state.input = {
    text: "A",
    pendingKey: "2",
    pendingIndex: 0, // "A"
    pendingAtMs: Date.now() - MULTITAP_WINDOW_MS - 1,
  };
  state = reduce(state, { type: "key", key: "enter" });
  expect(state.screen).toBe("login");
  expect(state.banner).toBe("Name must be at least 3 letters.");
  expect(state.input.text).toBe("AA"); // committed, not the stale "A"
  expect(state.input.pendingKey).toBeNull();
});

test("enter on login with valid name waits for the server (stays on login)", () => {
  let state = loginState();
  state.input = { text: "ABC", pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: "key", key: "enter" });
  expect(state.screen).toBe("login");
  expect(state.userName).toBeNull();
  expect(state.input.text).toBe("ABC"); // kept, so a refused name can be edited
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

function homeState(overrides: Partial<AppState> = {}): AppState {
  return { ...createInitialState(), screen: "home", userName: "ALICE", balanceCents: 100000, ...overrides };
}

test("logout action returns to login, clears userName and input", () => {
  let state = homeState({ userName: "ALICE", balanceCents: 100000 });
  state = reduce(state, { type: "logout" });
  expect(state.screen).toBe("login");
  expect(state.userName).toBeNull();
  expect(state.input.text).toBe("");
  expect(state.banner).toBe("You are signed out.");
});

test("busy action sets busy flag", () => {
  let state = loginState();
  state = reduce(state, { type: "busy", isBusy: true });
  expect(state.busy).toBe(true);
  state = reduce(state, { type: "busy", isBusy: false });
  expect(state.busy).toBe(false);
});

test("banner action sets banner message", () => {
  let state = loginState();
  state = reduce(state, { type: "banner", message: "Hello" });
  expect(state.banner).toBe("Hello");
  state = reduce(state, { type: "banner", message: null });
  expect(state.banner).toBeNull();
});

test("balance action updates balanceCents", () => {
  let state = homeState({ balanceCents: 100000 });
  state = reduce(state, { type: "balance", balanceCents: 50000 });
  expect(state.balanceCents).toBe(50000);
});

test("connection action updates connection status", () => {
  let state = loginState();
  state = reduce(state, { type: "connection", status: "connected" });
  expect(state.connection).toBe("connected");
});

test("amountMode action transitions to amount screen with mode", () => {
  let state = homeState({ userName: "ALICE", balanceCents: 100000 });
  state = reduce(state, { type: "amountMode", mode: "withdraw" });
  expect(state.screen).toBe("amount");
  expect(state.amountMode).toBe("withdraw");
  expect(state.amountDigits).toBe("");

  state = reduce(state, { type: "amountMode", mode: "deposit" });
  expect(state.amountMode).toBe("deposit");
});

// Spec §6 flow tests
test("login success sets userName, clears typed name and banner", () => {
  let state = loginState({
    input: { text: "ALICE", pendingKey: null, pendingIndex: 0, pendingAtMs: null },
    banner: "Signing in…",
  });
  state = reduce(state, { type: "login", userName: "ALICE" });
  expect(state.screen).toBe("home");
  expect(state.userName).toBe("ALICE");
  expect(state.input.text).toBe("");
  expect(state.banner).toBeNull();
});

test("nameTaken: server refusal keeps login screen and typed name", () => {
  let state = loginState({
    input: { text: "ALEX", pendingKey: null, pendingIndex: 0, pendingAtMs: null },
    busy: true,
  });
  // main.ts shows the server's message and never dispatches "login"
  state = reduce(state, { type: "busy", isBusy: false });
  state = reduce(state, { type: "banner", message: "That name is already in use. Try another name." });
  expect(state.screen).toBe("login");
  expect(state.userName).toBeNull();
  expect(state.input.text).toBe("ALEX");
  expect(state.banner).toBe("That name is already in use. Try another name.");
});
