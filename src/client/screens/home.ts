import { AppState } from "../state.js";
import { ViewModel } from "../ui/display.js";
import { formatCents } from "../ui/money.js";

// main.ts registers these once; the view stays pure.

let onWithdraw: () => void = () => {};
let onDeposit: () => void = () => {};
let onSignOut: () => void = () => {};

export function setHomeCallbacks(callbacks: { onWithdraw: () => void; onDeposit: () => void; onSignOut: () => void }) {
  onWithdraw = callbacks.onWithdraw;
  onDeposit = callbacks.onDeposit;
  onSignOut = callbacks.onSignOut;
}

export function homeView(state: AppState): ViewModel {
  return {
    title: `WELCOME, ${state.userName}`,
    lines: ["Balance", formatCents(state.balanceCents)],
  };
}
