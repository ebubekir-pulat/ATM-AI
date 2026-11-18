// src/client/main.ts
import { createInitialState, reduce, AppState } from "./state.js";
import { renderDisplay, ViewModel } from "./ui/display.js";
import { createKeypad } from "./ui/keypad.js";
import { loginView } from "./screens/login.js";
import { homeView } from "./screens/home.js";
import { amountView } from "./screens/amount.js";
import { messageView } from "./screens/message.js";
import { resolve } from "./ui/multitap.js";

const app = document.getElementById("app")!;
const displayRoot = document.createElement("div");
displayRoot.id = "display";
app.appendChild(displayRoot);

let state = createInitialState();

const keypad = createKeypad((key) => {
  state = reduce(state, { type: "key", key });
  render();
});
app.appendChild(keypad);

const hint = document.createElement("footer");
hint.className = "atm__hint";
hint.textContent = "Your name is used only in the log.";
app.appendChild(hint);

function getViewModel(state: AppState): ViewModel {
  switch (state.screen) {
    case "login":
      return loginView(state);
    case "home":
      return homeView(state);
    case "amount":
      return amountView(state);
    case "message":
      return messageView(state);
  }
}

function render() {
  const vm = getViewModel(state);
  renderDisplay(displayRoot, vm);
}

render();

// 200ms interval for multi-tap resolution
setInterval(() => {
  const now = Date.now();
  const newInput = resolve(state.input, now);
  if (newInput !== state.input) {
    state = { ...state, input: newInput };
    render();
  }
}, 200);
