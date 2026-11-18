import { Key } from "../state.js";

const KEY_CONFIG: Array<{
  key: Key;
  label: string;
  color: string;
  ariaLabel: string;
}> = [
  { key: "1", label: "1", color: "#d8dde3", ariaLabel: "Digit 1" },
  { key: "2", label: "2", color: "#d8dde3", ariaLabel: "Digit 2" },
  { key: "3", label: "3", color: "#d8dde3", ariaLabel: "Digit 3" },
  { key: "4", label: "4", color: "#d8dde3", ariaLabel: "Digit 4" },
  { key: "5", label: "5", color: "#d8dde3", ariaLabel: "Digit 5" },
  { key: "6", label: "6", color: "#d8dde3", ariaLabel: "Digit 6" },
  { key: "7", label: "7", color: "#d8dde3", ariaLabel: "Digit 7" },
  { key: "8", label: "8", color: "#d8dde3", ariaLabel: "Digit 8" },
  { key: "9", label: "9", color: "#d8dde3", ariaLabel: "Digit 9" },
  { key: "clear", label: "CLEAR", color: "#f2c744", ariaLabel: "Clear entry" },
  { key: "0", label: "0", color: "#d8dde3", ariaLabel: "Digit 0" },
  {
    key: "back",
    label: "BACK",
    color: "#c0392b",
    ariaLabel: "Delete last character",
  },
];

const BASE_STYLE =
  "border:none;border-radius:8px;min-height:56px;font-size:1.25rem;" +
  "font-weight:600;cursor:pointer;transition:filter 100ms;";

function attachPressFeedback(btn: HTMLButtonElement): void {
  btn.addEventListener("pointerdown", () => {
    btn.style.filter = "brightness(0.92)";
  });
  btn.addEventListener("pointerup", () => {
    btn.style.filter = "";
  });
  btn.addEventListener("pointerleave", () => {
    btn.style.filter = "";
  });
}

export function createKeypad(onKey: (key: Key) => void): HTMLElement {
  const nav = document.createElement("nav");
  nav.className = "atm__keypad";
  nav.setAttribute("role", "group");
  nav.setAttribute("aria-label", "ATM keypad");

  const grid = document.createElement("div");
  grid.className = "atm__keypad-grid";
  grid.setAttribute(
    "style",
    "display:grid;grid-template-columns:repeat(3,1fr);gap:10px;",
  );

  for (const config of KEY_CONFIG) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "atm__key";
    btn.textContent = config.label;
    const textColor = config.key === "back" ? "#fff" : "#000";
    btn.setAttribute(
      "style",
      `background:${config.color};color:${textColor};${BASE_STYLE}`,
    );
    btn.setAttribute("aria-label", config.ariaLabel);
    attachPressFeedback(btn);
    btn.addEventListener("click", () => onKey(config.key));
    grid.appendChild(btn);
  }

  nav.appendChild(grid);

  const enterBtn = document.createElement("button");
  enterBtn.type = "button";
  enterBtn.className = "atm__key atm__key--enter";
  enterBtn.textContent = "ENTER";
  enterBtn.setAttribute(
    "style",
    `grid-column:span 3;background:#27ae60;color:#fff;${BASE_STYLE}`,
  );
  enterBtn.setAttribute("aria-label", "Enter and confirm");
  attachPressFeedback(enterBtn);
  enterBtn.addEventListener("click", () => onKey("enter"));
  nav.appendChild(enterBtn);

  return nav;
}
