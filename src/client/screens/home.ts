import { AppState } from "../state.js";
import { ViewModel } from "../ui/display.js";
import { formatCents } from "../ui/money.js";

export function homeView(state: AppState): ViewModel {
  return {
    title: `WELCOME, ${state.userName || ""}`,
    lines: ["Balance", formatCents(state.balanceCents)],
  };
}
