import { expect, test } from "vitest";
import { createInitialState, reduce } from "../../src/client/state";

test("initial state is login screen with empty input", () => {
  const state = createInitialState();
  expect(state.screen).toBe("login");
  expect(state.input.text).toBe("");
  expect(state.userName).toBeNull();
});

test("reduce is a skeleton that returns the same state", () => {
  const state = createInitialState();
  expect(reduce(state, { type: "screen", to: "home" })).toBe(state);
});
