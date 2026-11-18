import { AppState } from "../state.js";
import { ViewModel } from "../ui/display.js";
import { formatCents } from "../ui/money.js";

export function amountView(state: AppState): ViewModel {
  const title = state.amountMode === "deposit" ? "DEPOSIT" : "WITHDRAWAL";
  return {
    title,
    lines: ["Enter amount in dollars", `Balance: ${formatCents(state.balanceCents)}`],
    input: state.amountDigits + "_",
  };
}
