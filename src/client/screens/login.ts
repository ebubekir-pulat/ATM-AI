import { AppState } from "../state.js";
import { ViewModel } from "../ui/display.js";
import { shownText } from "../ui/multitap.js";

export function loginView(state: AppState): ViewModel {
  return {
    title: "WELCOME",
    lines: ["Enter your name", "Use the keypad. 3 to 20 letters."],
    input: shownText(state.input),
    banner: state.banner,
    status: state.banner ? "error" : "info",
  };
}
