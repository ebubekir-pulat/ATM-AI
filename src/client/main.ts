import { createInitialState, reduce, AppState, Action, Key } from "./state.js";
import { renderDisplay, ViewModel } from "./ui/display.js";
import { createKeypad } from "./ui/keypad.js";
import { loginView } from "./screens/login.js";
import { homeView, setHomeCallbacks } from "./screens/home.js";
import { amountView } from "./screens/amount.js";
import { messageView } from "./screens/message.js";
import { resolve, shownText } from "./ui/multitap.js";
import {
  currentSession, getAccount, login, logout, nameAvailable,
  refreshSession, HttpError,
} from "./api.js";
import {
  MSG_CHECKING, MSG_SIGNING_IN, MSG_NAME_TAKEN, KEEPALIVE_MS,
} from "./messages.js";

const app = document.getElementById("app")!;
const displayRoot = document.createElement("div");
displayRoot.id = "display";
app.appendChild(displayRoot);

let state = createInitialState();
let availabilityTimer: number | null = null;
let lastAvailabilityName = "";

const keypad = createKeypad((key) => {
  if (state.busy) return;
  handleKey(key);
});
app.appendChild(keypad);

const hint = document.createElement("footer");
hint.className = "atm__hint";
hint.textContent = "Your name is used only in the log.";
app.appendChild(hint);

function getViewModel(appState: AppState): ViewModel {
  switch (appState.screen) {
    case "login": return loginView(appState);
    case "home": return homeView(appState);
    case "amount": return amountView(appState);
    case "message": return messageView(appState);
  }
}

function render() {
  renderDisplay(displayRoot, getViewModel(state));
}

function dispatch(action: Action) {
  state = reduce(state, action);
  render();
}

function handle401() {
  dispatch({ type: "logout" });
  dispatch({ type: "banner", message: "Session ended. Please log in again." });
}

async function loadAccount() {
  try {
    const account = await getAccount();
    dispatch({ type: "balance", balanceCents: account.balanceCents });
    return true;
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      handle401();
    } else {
      // Back to login with a clean state (logout clears userName/input),
      // then say what went wrong.
      dispatch({ type: "logout" });
      dispatch({ type: "banner", message: "Cannot reach the ATM server." });
    }
    return false;
  }
}

async function boot() {
  dispatch({ type: "banner", message: MSG_CHECKING });
  dispatch({ type: "busy", isBusy: true });
  try {
    const session = await currentSession();
    dispatch({ type: "login", userName: session.userName });
    await loadAccount();
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      handle401();
    } else if (e instanceof HttpError && e.code === "NETWORK") {
      dispatch({ type: "banner", message: "Cannot reach the ATM server." });
    } else {
      handle401();
    }
  } finally {
    dispatch({ type: "busy", isBusy: false });
  }
}

function scheduleAvailabilityCheck() {
  if (availabilityTimer) clearTimeout(availabilityTimer);
  const name = shownText(state.input).replace(/_$/, "");
  if (name.length < 3) {
    if (state.banner === MSG_NAME_TAKEN) {
      dispatch({ type: "banner", message: null });
    }
    return;
  }
  lastAvailabilityName = name;
  availabilityTimer = window.setTimeout(async () => {
    // Ignore stale reply: name must still match the screen
    if (shownText(state.input).replace(/_$/, "") !== lastAvailabilityName) return;
    try {
      const available = await nameAvailable(lastAvailabilityName);
      if (!available) {
        dispatch({ type: "banner", message: MSG_NAME_TAKEN });
      } else if (state.banner === MSG_NAME_TAKEN) {
        dispatch({ type: "banner", message: null });
      }
    } catch {
      // silent on NETWORK — never blocks ENTER
    }
  }, 500);
}

async function handleLoginEnter() {
  const name = shownText(state.input).replace(/_$/, "");
  if (name.length < 3) {
    dispatch({ type: "banner", message: "Name must be at least 3 letters." });
    return;
  }
  if (!/^[A-Z]{3,20}$/.test(name)) {
    dispatch({ type: "banner", message: "Name must be 3 to 20 letters (A-Z)." });
    return;
  }
  dispatch({ type: "busy", isBusy: true });
  dispatch({ type: "banner", message: MSG_SIGNING_IN });
  try {
    const result = await login(name);
    dispatch({ type: "login", userName: result.userName });
    await loadAccount();
    await refreshSession();
  } catch (e) {
    // 409/400: show server message, stay on login, keep typed name
    dispatch({
      type: "banner",
      message: e instanceof HttpError ? e.message : "Cannot reach the ATM server.",
    });
  } finally {
    dispatch({ type: "busy", isBusy: false });
  }
}

async function handleSignOut() {
  dispatch({ type: "busy", isBusy: true });
  try {
    await logout();
    dispatch({ type: "logout" }); // returns to login, banner "You are signed out."
    await refreshSession();
  } catch (e) {
    dispatch({
      type: "banner",
      message: e instanceof HttpError ? e.message : "Cannot reach the ATM server.",
    });
  } finally {
    dispatch({ type: "busy", isBusy: false });
  }
}

function handleKey(key: Key) {
  if (state.screen === "login" && key === "enter") {
    void handleLoginEnter();
    return;
  }
  dispatch({ type: "key", key });
  if (state.screen === "login") scheduleAvailabilityCheck();
}

setHomeCallbacks({
  onWithdraw: () => dispatch({ type: "amountMode", mode: "withdraw" }),
  onDeposit: () => dispatch({ type: "amountMode", mode: "deposit" }),
  onSignOut: () => { void handleSignOut(); },
});

render();
boot();

// Keepalive: the server sweeps sessions silent for SESSION_GRACE_MS (60s).
// Without this, a quiet open tab would be logged out after a minute.
setInterval(() => {
  if (state.screen !== "home" || state.busy) return;
  void currentSession()
    .then(() => {
      // Session alive — nothing to do.
    })
    .catch((e) => {
      // Network blips never disturb the screen; a 401 means the session died.
      if (e instanceof HttpError && e.status === 401) handle401();
    });
}, KEEPALIVE_MS);

// 200ms interval for multi-tap resolution
setInterval(() => {
  const newInput = resolve(state.input, Date.now());
  if (newInput !== state.input) {
    state = { ...state, input: newInput };
    if (state.screen === "login") scheduleAvailabilityCheck();
    render();
  }
}, 200);
