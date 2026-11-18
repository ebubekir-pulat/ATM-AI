import { backspace, clearAll, press, resolve, shownText } from "./ui/multitap.js";

export type ScreenName = "login" | "home" | "amount" | "message";
export type Connection = "connected" | "connecting" | "offline";

export interface MultiTapState {
  text: string;
  pendingKey: string | null;
  pendingIndex: number;
  pendingAtMs: number | null;
}

export interface ActivityEntry {
  timestamp: number;
  type: string;
  amountCents?: number;
  balanceAfterCents?: number;
}

export interface LockState {
  lockedAt: number;
  expiresAt: number;
  attempts: number;
}

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
  | { type: "login"; userName: string };

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
      return { ...state, userName: action.userName, screen: "home", banner: null };

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
              return { ...state, banner: "Name must be at least 3 letters." };
            }
            return {
              ...state,
              screen: "home",
              userName: name,
              input: clearAll(),
              banner: null,
            };
          }
        }
      }

      if (state.screen === "amount") {
        if (action.key >= "0" && action.key <= "9") {
          return { ...state, amountDigits: state.amountDigits + action.key };
        }
        switch (action.key) {
          case "clear":
            return { ...state, amountDigits: "" };
          case "back":
            if (state.amountDigits.length > 0) {
              return { ...state, amountDigits: state.amountDigits.slice(0, -1) };
            }
            return { ...state, screen: "home", amountMode: null, amountDigits: "" };
        }
      }

      return { ...state, input };
    }
  }
  return state;
}
