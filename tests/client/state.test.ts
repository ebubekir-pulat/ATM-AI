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

test("lock action stores the lock state it was sent", () => {
  const lock = { locked: true, ownerName: "ALICE", isMine: false, expiresAtMs: 1234 };
  const state = reduce(createInitialState(), { type: "lock", lock });
  expect(state.lock).toEqual(lock);
});

test("activity action keeps only the last 20 entries", () => {
  let state = createInitialState();
  for (let i = 1; i <= 21; i++) {
    state = reduce(state, {
      type: "activity",
      entry: {
        id: i,
        eventType: "login",
        userName: `USER${i}`,
        amountCents: null,
        balanceAfterCents: null,
        reason: null,
        timestampMs: i,
        localDate: "2026-11-25",
        localTime: "12:00:00",
        message: `USER${i}: Logged in at 12:00:00`,
      },
    });
  }
  expect(state.recentActivity).toHaveLength(20);
  expect(state.recentActivity[0].id).toBe(2);
  expect(state.recentActivity[19].id).toBe(21);
});
