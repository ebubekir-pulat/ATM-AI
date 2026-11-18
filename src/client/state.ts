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
  // TODO: implement transitions in a later task
  return state;
}
