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
