import type { Connection } from "../state.js";

export interface ActionViewModel {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

export interface ViewModel {
  title: string;
  lines: string[];
  input?: string;
  banner?: string | null;
  status?: "info" | "success" | "error";
  connection?: Connection;
  actions?: ActionViewModel[];
}

const CONNECTION_LABELS: Record<Connection, string> = {
  connected: "Live",
  connecting: "Reconnecting…",
  offline: "Offline",
};

export function renderDisplay(root: HTMLElement, vm: ViewModel): void {
  root.innerHTML = "";

  const screen = document.createElement("div");
  screen.className = "atm__screen";
  screen.setAttribute("aria-live", "polite");

  if (vm.connection) {
    const status = document.createElement("div");
    status.className = "atm__status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const dot = document.createElement("span");
    dot.className = `atm__status-dot atm__status-dot--${vm.connection}`;

    const label = document.createElement("span");
    label.textContent = CONNECTION_LABELS[vm.connection];

    status.append(dot, label);
    screen.appendChild(status);
  }

  const title = document.createElement("div");
  title.className = "atm__title";
  title.textContent = vm.title;
  screen.appendChild(title);

  for (const line of vm.lines) {
    const lineEl = document.createElement("div");
    lineEl.className = "atm__line";
    lineEl.textContent = line;
    screen.appendChild(lineEl);
  }

  if (vm.input !== undefined) {
    const input = document.createElement("div");
    input.className = "atm__input";
    input.textContent = vm.input;
    screen.appendChild(input);
  }

  if (vm.banner) {
    const banner = document.createElement("div");
    banner.className = `atm__banner atm__banner--${vm.status || "info"}`;
    banner.textContent = vm.banner;
    screen.appendChild(banner);
  }

  if (vm.actions && vm.actions.length > 0) {
    const actions = document.createElement("div");
    actions.className = "atm__actions";

    for (const action of vm.actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `atm__action ${action.className ?? ""}`.trim();
      btn.textContent = action.label;
      btn.disabled = action.disabled ?? false;
      btn.addEventListener("click", action.onClick);
      actions.appendChild(btn);
    }
    screen.appendChild(actions);
  }

  root.appendChild(screen);
}
