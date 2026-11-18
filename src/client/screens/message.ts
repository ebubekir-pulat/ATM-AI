import { AppState } from "../state.js";
import { ViewModel } from "../ui/display.js";

export function messageView(state: AppState): ViewModel {
  return {
    title: state.message?.title || "",
    lines: state.message?.body ? [state.message.body] : [],
  };
}
