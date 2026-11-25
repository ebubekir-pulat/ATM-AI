import { backspace, clearAll, press, resolve, shownText } from "./ui/multitap.js";
import type { ActivityEntry, LockState } from "../shared/types.js";

export type ScreenName = "login" | "home" | "amount" | "message";
export type Connection = "connected" | "connecting" | "offline";

export interface MultiTapState {
  text: string;
  pendingKey: string | null;
  pendingIndex: number;
  pendingAtMs: number | null;
}

export const MAX_RECENT_ACTIVITY = 20;

export interface AppState {
  screen: ScreenName;
  userName: string | null;
  balanceCents: number;
  lock: LockState | null;
  amountMode: "withdraw" | "deposit" | null;
  input: MultiTapState;
  amountDigits: string;
  busy: boolean;
  banner: string | null;
  message: { title: string; body: string } | null;
  connection: Connection;
  recentActivity: ActivityEntry[];
}

export type Key =
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "clear"
  | "back"
  | "enter";

export type Action =
  | { type: "key"; key: Key }
  | { type: "screen"; to: ScreenName }
  | { type: "login"; userName: string }
  | { type: "logout" }
  | { type: "busy"; isBusy: boolean }
  | { type: "banner"; message: string | null }
  | { type: "balance"; balanceCents: number }
  | { type: "lock"; lock: LockState }
  | { type: "activity"; entry: ActivityEntry }
  | { type: "connection"; status: Connection }
  | { type: "amountMode"; mode: "withdraw" | "deposit" };

export const MULTITAP_WINDOW_MS = 800;
export const MAX_NAME_LENGTH = 20;

export function createMultiTap(): MultiTapState {
  return { text: "", pendingKey: null, pendingIndex: 0, pendingAtMs: null };
}

export function createInitialState(): AppState {
  return {
    screen: "login",
    userName: null,
    balanceCents: 0,
    lock: null,
    amountMode: null,
    input: createMultiTap(),
    amountDigits: "",
    busy: false,
    banner: null,
    message: null,
    connection: "connecting",
    recentActivity: [],
  };
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "screen":
      return { ...state, screen: action.to };

    case "login":
      // Server confirmed: go home with a clean entry (spec §4 "reset input").
      return { ...state, userName: action.userName, screen: "home", input: createMultiTap(), banner: null };

    case "logout":
      return {
        ...state,
        screen: "login",
        userName: null,
        balanceCents: 0,
        input: createMultiTap(),
        banner: "You are signed out.",
        busy: false,
      };

    case "busy":
      return { ...state, busy: action.isBusy };

    case "banner":
      return { ...state, banner: action.message };

    case "balance":
      return { ...state, balanceCents: action.balanceCents };

    case "lock":
      return { ...state, lock: action.lock };

    case "activity": {
      const recentActivity = [...state.recentActivity, action.entry];
      return { ...state, recentActivity: recentActivity.slice(-MAX_RECENT_ACTIVITY) };
    }

    case "connection":
      return { ...state, connection: action.status };

    case "amountMode":
      return { ...state, screen: "amount", amountMode: action.mode, amountDigits: "" };

    case "key": {
      const now = Date.now();
      const input = resolve(state.input, now);

      if (state.screen === "login") {
        if (action.key >= "0" && action.key <= "9") {
          return { ...state, input: press(input, action.key, now), banner: null };
        }
        switch (action.key) {
          case "clear":
            return { ...state, input: clearAll(), banner: null };
          case "back":
            return { ...state, input: backspace(input), banner: null };
          case "enter": {
            const name = shownText(input).replace(/_$/, "");
            if (name.length < 3) {
              return { ...state, input, banner: "Name must be at least 3 letters." };
            }
            // Valid name: main.ts intercepts ENTER and calls the server.
            // Returning state unchanged keeps the typed name if the request fails.
            return { ...state, input };
          }
        }
      }

      if (state.screen === "amount") {
        if (action.key >= "0" && action.key <= "9") {
          return { ...state, input, amountDigits: state.amountDigits + action.key };
        }
        switch (action.key) {
          case "clear":
            return { ...state, input, amountDigits: "" };
          case "back":
            if (state.amountDigits.length > 0) {
              return { ...state, input, amountDigits: state.amountDigits.slice(0, -1) };
            }
            return { ...state, input, screen: "home", amountMode: null, amountDigits: "" };
        }
      }

      return { ...state, input };
    }
  }
  return state;
}
