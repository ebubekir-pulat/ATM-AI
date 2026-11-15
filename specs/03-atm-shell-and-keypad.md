# 03 — ATM Shell, Keypad and Multi-Tap Input

**Depends on:** `02`.
**Delivers:** the ATM machine in the browser: frame, display, fifteen buttons, the
screen router, and a finished text/number input engine. No network calls yet.
**Covers:** `specs.txt` §2 (ATM UI), §3 items 2–5 (multi-tap typing), and the
client half of §13 B (Back returns to the previous screen).

---

## 1. The thing being built

```
                     white page background
  ┌──────────────────────────────────────────┐
  │  ┌────────────────────────────────────┐  │  .atm__screen
  │  │  WELCOME                           │  │  <- title line
  │  │                                    │  │
  │  │  Enter your name                   │  │  <- prompt line
  │  │                                    │  │
  │  │  US_                               │  │  <- input echo, caret
  │  └────────────────────────────────────┘  │
  │      ┌─────┬─────┬─────┐                 │
  │      │  1  │  2  │  3  │                 │
  │      ├─────┼─────┼─────┤                 │
  │      │  4  │  5  │  6  │                 │  .atm__keypad
  │      ├─────┼─────┼─────┤                 │  grey keys, black text
  │      │  7  │  8  │  9  │                 │
  │      ├─────┼─────┼─────┤                 │
  │      │CLEAR│  0  │ BACK│                 │  yellow / grey / red
  │      └─────┴─────┴─────┘                 │
  │      ┌───────────────────┐               │
  │      │      ENTER        │               │  green, full width
  │      └───────────────────┘               │
  └──────────────────────────────────────────┘
                        (AI button, slice 08)
```

The ATM is the only dark object on the page. The page stays white so the AI
assistant button (slice 08) sits on white, as the source spec requires.

## 2. Files

Create: `tsconfig.client.json`, `src/client/main.ts`, `src/client/state.ts`,
`src/client/screens/login.ts` (placeholder screen for now), `src/client/screens/home.ts`
(placeholder), `src/client/screens/amount.ts` (placeholder),
`src/client/screens/message.ts` (placeholder), `src/client/ui/display.ts`,
`src/client/ui/keypad.ts`, `src/client/ui/multitap.ts`, `public/css/atm.css`
(replaces the stub), and `public/index.html` (rewritten).
Modify: `package.json` (`"build": "tsc -p tsconfig.json && tsc -p tsconfig.client.json"`).
Tests: `tests/client/multitap.test.ts`, `tests/client/router.test.ts`,
`tests/client/formatInput.test.ts`.

`tsconfig.client.json`: `target ES2022`, `module ESNext`,
`moduleResolution bundler` (the only module setting that combination allows),
`strict`, `lib ["ES2022","DOM"]`, `rootDir "src"`, `outDir "public/js"`,
`include: ["src/client/**/*.ts", "src/shared/**/*.ts"]`. The browser entry is
therefore `/js/client/main.js`.

`public/js/` is generated output and is never edited by hand.

## 3. State

One object, one render function. Screens do not touch the DOM directly; they
return a view model and `display.ts` paints it.

```ts
// src/client/state.ts
export type ScreenName = "login" | "home" | "amount" | "message";
export type Connection = "connected" | "connecting" | "offline";

export interface AppState {
  screen: ScreenName;
  userName: string | null;
  balanceCents: number;
  lock: LockState | null;          // shape from 01; used from slice 07
  amountMode: "withdraw" | "deposit" | null;
  input: MultiTapState;            // used by login
  amountDigits: string;            // used by amount
  busy: boolean;                   // a request is in flight
  banner: string | null;           // one-line status shown under the title
  message: { title: string; body: string } | null;  // used by `message`
  connection: Connection;          // used from slice 05
  recentActivity: ActivityEntry[]; // last 20 entries, used from slice 08
}
```

`lock`, `connection` and `recentActivity` are declared now so later slices extend
behaviour rather than the state type. Until their slices, they hold `null`, `"connecting"`
and `[]`.

Widths: the ATM is at most `420px` wide, the screen is `4:3`, the keypad is a
`3`-column grid for digits plus a full-width ENTER row. Buttons are at least
`56px` tall so they work with a thumb on a phone.

## 4. The router

`state.ts` owns `setScreen(next: ScreenName)` and calls `render()`.
`main.ts` subscribes: `render()` → clear `#display` → ask the current screen
module for a `ViewModel` → `display.ts` paints it.

```ts
// src/client/ui/display.ts
export interface ViewModel {
  title: string;
  lines: string[];       // prompt / instructions, one per line
  input?: string;        // the echoed entry, with a trailing caret
  banner?: string | null;
  status?: "info" | "success" | "error";
}
export function renderDisplay(root: HTMLElement, vm: ViewModel): void;
```

`router.test.ts` covers the transitions this slice needs and the ones slice 04
adds, using the pure reducer:

```ts
export function reduce(state: AppState, action: Action): AppState;
type Action =
  | { type: "key"; key: Key }              // "0".."9" | "clear" | "back" | "enter"
  | { type: "screen"; to: ScreenName }
  | { type: "login"; userName: string };
```

Pin, in tests:

- `key` with a digit on `login` appends through multi-tap.
- `back` on `login` deletes one character, and does **not** leave the screen.
- `back` on `amount` deletes one digit; with an empty entry it returns to `home`
  (the cancel path — slice 07 attaches lock release to it).
- `enter` on `login` with a name shorter than 3 characters keeps the screen on
  `login` and sets `banner` to `Name must be at least 3 letters.`
- `enter` on `login` with a valid name moves to `home` with `userName` set. This is
  placeholder behaviour: slice 04 replaces it with a server call, keeping the local
  length check as a fast path.

## 5. Keypad

```ts
// src/client/ui/keypad.ts
export type Key = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
                | "clear" | "back" | "enter";
export function createKeypad(onKey: (key: Key) => void): HTMLElement;
```

- Layout order, left to right, top to bottom: `1 2 3 / 4 5 6 / 7 8 9 / clear 0 back`,
  then `enter` on its own row.
- Labels: `CLEAR` (yellow), `BACK` (red), `ENTER` (green). Digits are grey.
- Colour is also carried by text: every button has `aria-label` (`Clear entry`,
  `Delete last character`, `Enter and confirm`) so colour is not the only cue.
- Both `click` and touch produce exactly one `onKey` call; the keypad uses
  `pointerdown` for feedback and `click` for the action, so no double fire.
- A physical keyboard also works: digits map to themselves, `Backspace` → `back`,
  `Delete`/`Escape` → `clear`, `Enter` → `enter`. Keys are ignored while
  `state.busy` is true and while focus is inside a text field (the AI chat box in
  slice 08), so typing a question never operates the ATM.

## 6. Multi-tap

```ts
// src/client/ui/multitap.ts
export interface MultiTapState {
  text: string;                      // committed characters
  pendingKey: string | null;         // key currently cycling, e.g. "2"
  pendingIndex: number;              // 0-based index into the key's letters
  pendingAtMs: number | null;        // when pendingIndex last advanced
}
export function createMultiTap(): MultiTapState;
export function press(state: MultiTapState, key: string, nowMs: number): MultiTapState;
export function resolve(state: MultiTapState, nowMs: number): MultiTapState; // commit an expired pending
export function backspace(state: MultiTapState): MultiTapState;
export function clearAll(): MultiTapState;
export function shownText(state: MultiTapState): string; // text + pending letter
```

Rules, all pinned by tests:

1. Mapping: `2 ABC`, `3 DEF`, `4 GHI`, `5 JKL`, `6 MNO`, `7 PQRS`, `8 TUV`,
   `9 WXYZ`. `0` and `1` are ignored for text (names are A–Z only, no spaces).
2. Pressing the **same** key again within `MULTITAP_WINDOW_MS` (800 ms) advances
   the pending letter, wrapping (`P→Q→R→S→P`).
3. Pressing a **different** key commits the pending letter and starts a new one.
   No timing is needed for this commit.
4. `resolve` is called on every render tick; if `nowMs - pendingAtMs` exceeds the
   window, the pending letter is committed. The pending letter is therefore never
   lost by waiting.
5. `backspace` deletes one visible character: the pending letter if there is one,
   otherwise the last committed character.
6. `clearAll()` empties everything, pending included.
7. Committed length plus pending never exceeds `MAX_NAME_LENGTH` (20). Further
   keys are ignored while at the cap.

Display: `shownText()` plus `_` as the caret. `US` with a pending `E` shows `USE_`.

`main.ts` runs a `requestAnimationFrame`-free loop instead of a timer per press: a
single `setInterval(…, 200)` calls `resolve(state, Date.now())` and re-renders only
when the state object changed. One interval for the whole app, cleared on unload.

## 7. Screens in this slice

Placeholders, but with their final layout so slice 04 and 06 only fill in
behaviour:

| Screen | Title | Lines | Input |
|--------|-------|-------|-------|
| `login` | `WELCOME` | `Enter your name`, `Use the keypad. 3 to 20 letters.` | multi-tap echo |
| `home` | `WELCOME, <NAME>` | `Balance`, then the formatted balance on its own line | none |
| `amount` | `WITHDRAWAL` / `DEPOSIT` | `Enter amount in dollars`, `Balance: $…` | amount digits |
| `message` | from `state.message.title` | `state.message.body` | none |

`home` and `amount` in this slice show static placeholder numbers (`$0.00`) because
there is no API client yet. `enter` on `home` and `home` buttons are wired in slice 04.

`balanceCents` is formatted **on the client** for display only, with the same
`Intl` call as the server. The value itself always comes from the server; the
client never computes a new balance.

## 8. `main.ts`

1. Read `#app`, build the ATM frame: `section.atm > div.atm__screen#display`,
   `nav.atm__keypad`, `footer.atm__hint` (`Your name is used only in the log.`).
2. Create initial state on `login`, call `render()`.
3. Attach the keypad with a handler that dispatches `reduce`.
4. Install the 200 ms resolve/render interval.
5. Log nothing to the console in normal operation.

`index.html` loads `<script type="module" src="/js/client/main.js"></script>` after the
markup, so `main.ts` may assume the elements exist.

## 9. CSS requirements

- Page: white background, system sans-serif, ATM centred, `min-height: 100dvh`.
- `.atm`: dark slate frame, generous padding, `border-radius: 18px`, subtle shadow.
- `.atm__screen`: monospace, dark green background, pale green text, fixed
  min-height, `white-space: pre-wrap`, vertical scroll if a message is long,
  `aria-live="polite"` so error feedback is announced.
- `.keypad` grid: `grid-template-columns: repeat(3, 1fr)`, `gap: 10px`;
  ENTER spans all three columns.
- Key colours: digits `#d8dde3`, CLEAR `#f2c744` with black text, BACK `#c0392b`
  with white text, ENTER `#27ae60` with white text. Hover/active states darken
  by 8 %; `:focus-visible` draws a 2 px outline.
- No animation longer than 150 ms; nothing moves while a transaction is in flight.

## 10. Tests

`multitap.test.ts` covers §6 rules 1–7 with explicit `nowMs` values (no timers).
`formatInput.test.ts` covers the caret string and the digit cap.
`router.test.ts` covers the transitions in §4. All three are pure functions under
`tests/client/`, run by the same `npm test`; no DOM and no jsdom dependency.

## 11. Acceptance criteria

- [ ] `npm run build` emits `public/js/client/main.js` and friends; `npm start` serves a
      page that renders the ATM shown in §1.
- [ ] Typing `2` three times slowly gives `A` `A` `A`; three times quickly gives `C`;
      `7` pressed five times quickly wraps back to `P`.
- [ ] CLEAR empties the entry; BACK removes one character; ENTER with `AB` shows
      `Name must be at least 3 letters.` and stays on the login screen.
- [ ] ENTER with `ABC` goes to the home screen and the title reads `WELCOME, ABC`.
- [ ] BACK on the amount screen deletes a digit, and on an empty entry returns to home.
- [ ] On a phone-sized viewport (375 px) the ATM fits without horizontal
      scrolling and every key is reachable with a thumb.
- [ ] The physical keyboard drives the same actions, and typing inside a text
      field does not operate the ATM.
- [ ] `npm test` passes; no console errors in the browser.
