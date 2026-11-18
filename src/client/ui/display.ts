export interface ViewModel {
  title: string;
  lines: string[];
  input?: string;
  banner?: string | null;
  status?: "info" | "success" | "error";
}

export function renderDisplay(root: HTMLElement, vm: ViewModel): void {
  root.innerHTML = "";

  const screen = document.createElement("div");
  screen.className = "atm__screen";
  screen.setAttribute("aria-live", "polite");

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

  root.appendChild(screen);
}
