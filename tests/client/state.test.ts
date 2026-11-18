import { expect, test } from "vitest";
import { createInitialState, reduce } from "../../src/client/state";

test("initial state is login screen with empty input", () => {
  const state = createInitialState();
  expect(state.screen).toBe("login");
  expect(state.input.text).toBe("");
  expect(state.userName).toBeNull();
});

test("screen action moves to the requested screen without mutating the original", () => {
  const state = createInitialState();
  const next = reduce(state, { type: "screen", to: "home" });
  expect(next.screen).toBe("home");
  expect(state.screen).toBe("login");
});
