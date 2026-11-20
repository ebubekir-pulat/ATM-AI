import { expect, test } from "vitest";
import { amountView, homeView, loginView, messageView } from "../../src/client/screens";
import { createInitialState } from "../../src/client/state";

test("loginView shows welcome and multi-tap input", () => {
  const state = createInitialState();
  state.input = { text: "US", pendingKey: "2", pendingIndex: 0, pendingAtMs: 1000 }; // US + A pending
  const vm = loginView(state);
  expect(vm.title).toBe("WELCOME");
  expect(vm.lines).toEqual(["Enter your name", "Use the keypad. 3 to 20 letters."]);
  expect(vm.input).toBe("USA_");
});

test("homeView shows welcome with name and balance", () => {
  const state = createInitialState();
  state.screen = "home";
  state.userName = "ALICE";
  state.balanceCents = 123456;
  const vm = homeView(state);
  expect(vm.title).toBe("WELCOME, ALICE");
  expect(vm.lines[0]).toBe("Balance");
  expect(vm.lines[1]).toBe("$1,234.56");
  expect(vm.input).toBeUndefined();
});

test("amountView shows withdrawal title and balance", () => {
  const state = createInitialState();
  state.screen = "amount";
  state.amountMode = "withdraw";
  state.balanceCents = 50000;
  state.amountDigits = "100";
  const vm = amountView(state);
  expect(vm.title).toBe("WITHDRAWAL");
  expect(vm.lines).toEqual(["Enter amount in dollars", "Balance: $500.00"]);
  expect(vm.input).toBe("100_");
});

test("amountView shows deposit title", () => {
  const state = createInitialState();
  state.screen = "amount";
  state.amountMode = "deposit";
  const vm = amountView(state);
  expect(vm.title).toBe("DEPOSIT");
});

test("messageView shows title and body", () => {
  const state = createInitialState();
  state.screen = "message";
  state.message = { title: "ERROR", body: "Something went wrong" };
  const vm = messageView(state);
  expect(vm.title).toBe("ERROR");
  expect(vm.lines).toEqual(["Something went wrong"]);
  expect(vm.input).toBeUndefined();
});

test("transient banners render as info, real ones as error", () => {
  const checking = { ...createInitialState(), screen: "login" as const, banner: "Checking session…" };
  expect(loginView(checking).status).toBe("info");

  const signingIn = { ...createInitialState(), screen: "login" as const, banner: "Signing in…" };
  expect(loginView(signingIn).status).toBe("info");

  const nameTaken = { ...createInitialState(), screen: "login" as const, banner: "That name is already in use. Try another name." };
  expect(loginView(nameTaken).status).toBe("error");
});
