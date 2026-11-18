import {
  MAX_NAME_LENGTH,
  MULTITAP_WINDOW_MS,
  MultiTapState,
} from "../state.js";

export { MAX_NAME_LENGTH, MULTITAP_WINDOW_MS };

const KEY_MAP: Record<string, string> = {
  "2": "ABC",
  "3": "DEF",
  "4": "GHI",
  "5": "JKL",
  "6": "MNO",
  "7": "PQRS",
  "8": "TUV",
  "9": "WXYZ",
};

export function createMultiTap(): MultiTapState {
  return { text: "", pendingKey: null, pendingIndex: 0, pendingAtMs: null };
}

export function press(state: MultiTapState, key: string, nowMs: number): MultiTapState {
  const letters = KEY_MAP[key];
  if (!letters) return state;

  const isAdvance =
    state.pendingKey === key &&
    state.pendingAtMs !== null &&
    nowMs - state.pendingAtMs < MULTITAP_WINDOW_MS;

  // Advancing the pending letter does not commit, so the length cap does not apply.
  if (isAdvance) {
    const nextIndex = (state.pendingIndex + 1) % letters.length;
    return { ...state, pendingIndex: nextIndex, pendingAtMs: nowMs };
  }

  // A new cycle commits any pending letter first, then starts a new pending
  // only while committed + pending stays within MAX_NAME_LENGTH.
  let newText = state.text;
  if (state.pendingKey) {
    const previousLetters = KEY_MAP[state.pendingKey];
    if (previousLetters) {
      newText += previousLetters[state.pendingIndex];
    }
  }

  if (newText.length >= MAX_NAME_LENGTH) {
    return { text: newText, pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  }

  return { text: newText, pendingKey: key, pendingIndex: 0, pendingAtMs: nowMs };
}

export function resolve(state: MultiTapState, nowMs: number): MultiTapState {
  if (!state.pendingKey || state.pendingAtMs === null) return state;
  if (nowMs - state.pendingAtMs < MULTITAP_WINDOW_MS) return state;

  const letters = KEY_MAP[state.pendingKey];
  if (!letters) return state;

  return {
    text: state.text + letters[state.pendingIndex],
    pendingKey: null,
    pendingIndex: 0,
    pendingAtMs: null,
  };
}

export function backspace(state: MultiTapState): MultiTapState {
  if (state.pendingKey) {
    return { ...state, pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  }
  if (state.text.length > 0) {
    return { ...state, text: state.text.slice(0, -1) };
  }
  return state;
}

export function clearAll(): MultiTapState {
  return createMultiTap();
}

export function shownText(state: MultiTapState): string {
  if (!state.pendingKey) return state.text + "_";
  const letters = KEY_MAP[state.pendingKey];
  if (!letters) return state.text + "_";
  return state.text + letters[state.pendingIndex] + "_";
}
