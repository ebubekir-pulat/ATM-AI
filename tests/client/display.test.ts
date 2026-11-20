// @vitest-environment jsdom
import { beforeEach, expect, test } from "vitest";
import { renderDisplay } from "../../src/client/ui/display";

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
});

test("renders title, lines, input with caret, and banner", () => {
  const root = document.getElementById("root")!;
  renderDisplay(root, {
    title: "WELCOME",
    lines: ["Enter your name", "Use the keypad. 3 to 20 letters."],
    input: "US_",
    banner: null,
    status: "info",
  });

  expect(root.querySelector(".atm__title")?.textContent).toBe("WELCOME");
  expect(root.querySelectorAll(".atm__line").length).toBe(2);
  expect(root.querySelector(".atm__input")?.textContent).toBe("US_");
  expect(root.querySelector(".atm__banner")).toBeNull();
});

test("renders error banner with status", () => {
  const root = document.getElementById("root")!;
  renderDisplay(root, {
    title: "WELCOME",
    lines: ["Enter your name"],
    input: "AB_",
    banner: "Name must be at least 3 letters.",
    status: "error",
  });

  const banner = root.querySelector(".atm__banner") as HTMLElement;
  expect(banner).not.toBeNull();
  expect(banner.textContent).toBe("Name must be at least 3 letters.");
  expect(banner.classList.contains("atm__banner--error")).toBe(true);
});

test("renders real buttons that fire their onClick", () => {
  const root = document.getElementById("root")!;
  let clicks = 0;
  renderDisplay(root, {
    title: "WELCOME, USER1",
    lines: ["Balance", "$1,000.00"],
    actions: [
      { label: "Sign out", onClick: () => clicks++ },
      { label: "Withdraw", onClick: () => {}, disabled: true },
    ],
  });

  const buttons = root.querySelectorAll<HTMLButtonElement>("button.atm__action");
  expect(buttons).toHaveLength(2);
  expect(root.querySelector(".atm__actions")).not.toBeNull();

  buttons[0].click();
  expect(clicks).toBe(1);

  expect(buttons[1].disabled).toBe(true);
  buttons[1].click();
  expect(clicks).toBe(1); // disabled buttons do nothing
});
