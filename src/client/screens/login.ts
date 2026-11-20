import { AppState } from "../state.js";
import { ViewModel } from "../ui/display.js";
import { shownText } from "../ui/multitap.js";
import { MSG_CHECKING, MSG_SIGNING_IN } from "../messages.js";

const TRANSIENT = new Set([MSG_CHECKING, MSG_SIGNING_IN]);

export function loginView(state: AppState): ViewModel {
  return {
    title: "WELCOME",
    lines: ["Enter your name", "Use the keypad. 3 to 20 letters."],
    input: shownText(state.input),
    banner: state.banner,
    status: state.banner && !TRANSIENT.has(state.banner) ? "error" : "info",
  };
}
