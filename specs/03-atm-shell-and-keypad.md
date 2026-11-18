# 03 — ATM Shell, Keypad and Multi-Tap Input

**Depends on:** `02`.
**Delivers:** the ATM in the browser: frame, display, fifteen buttons, screen router,
and the finished text/number input engine. No network calls yet.
**Covers:** `specs.txt` §2 (ATM UI), §3 items 2–5 (multi-tap typing), the client half
of §13 B (Back returns to the previous screen).

---

## 1. The thing being built

```
                     white page background
  ┌──────────────────────────────────────────┐
  │  ┌────────────────────────────────────┐  │  .atm__screen
  │  │  WELCOME                           │  │  <- title line
  │  │  Enter your name                   │  │  <- prompt line
  │  │  US_                               │  │  <- input echo, caret
  │  └────────────────────────────────────┘  │
  │      ┌─────┬─────┬─────┐                 │
  │      │  1  │  2  │  3  │                 │
  │      ├─────┼─────┼─────┤                 │  .atm__keypad
  │      │  4  │  5  │  6  │                 │  grey keys, black text
  │      ├─────┼─────┼─────┤                 │
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

The ATM is the only dark object on the page; the page stays white so the AI button
(slice 08) sits on white as the source spec requires.

Files: create `tsconfig.client.json`, everything under `src/client/` named in `01` §2
(screens and `ui/money.ts` start as placeholders), real `public/index.html` and
`public/css/atm.css`; modify `package.json` so `build` runs both `tsc` projects. Tests:
`tests/client/{multitap,router,formatInput}.test.ts`. `public/js/` is generated output,
never edited by hand. The browser entry is `/js/client/main.js`.

## 2. State

One object, one render function. Screens never touch the DOM: they return a view model
and `display.ts` paints it.

```ts
// src/client/state.ts
export type ScreenName = "login" | "home" | "amount" | "message";
export type Connection = "connected" | "connecting" | "offline";

export interface AppState {
  screen: ScreenName;
  userName: string | null;
  balanceCents: number;
  lock: LockState | null;          // from slice 07
  amountMode: "withdraw" | "deposit" | null;
  input: MultiTapState;            // login
  amountDigits: string;            // amount
  busy: boolean;                   // a request is in flight
  banner: string | null;           // one-line status under the title
  message: { title: string; body: string } | null;
  connection: Connection;          // from slice 05
  recentActivity: ActivityEntry[]; // last 20, from slice 08
}
```

`lock`, `connection` and `recentActivity` are declared now so later slices extend
behaviour, not the state type; until then they hold `null`, `"connecting"` and `[]`.

Layout: ATM at most `420px` wide, screen `4:3`, keypad a 3-column grid plus a
full-width ENTER row, buttons at least `56px` tall for a thumb.

## 3. Router

`state.ts` owns `setScreen(next: ScreenName)`, which calls `render()`. `main.ts`
subscribes: `render()` → ask the current screen for a `ViewModel` → `display.ts` paints
it.

```ts
// src/client/ui/display.ts
export interface ViewModel {
  title: string;
  lines: string[];       // prompt / instructions, one per line
  input?: string;        // echoed entry, with a trailing caret
  banner?: string | null;
  status?: "info" | "success" | "error";
}
export function renderDisplay(root: HTMLElement, vm: ViewModel): void;

// pure reducer, tested without a DOM
export function reduce(state: AppState, action: Action): AppState;
type Action =
  | { type: "key"; key: Key }              // "0".."9" | "clear" | "back" | "enter"
  | { type: "screen"; to: ScreenName }
  | { type: "login"; userName: string };   // slice 04 replaces this with a server call
```

`router.test.ts` pins:

- digit on `login` appends through multi-tap;
- `back` on `login` deletes one character and does **not** leave the screen;
- `back` on `amount` deletes one digit; on an empty entry it returns to `home` (the
  cancel path — slice 07 attaches the lock release to it);
- `enter` on `login` with fewer than 3 characters stays on `login` with banner
  `Name must be at least 3 letters.`;
- `enter` on `login` with a valid name moves to `home` with `userName` set (keep the
  local length check as a fast path once slice 04 adds the request).

## 4. Keypad

```ts
// src/client/ui/keypad.ts
export type Key = "0"|"1"|"2"|"3"|"4"|"5"|"6"|"7"|"8"|"9"|"clear"|"back"|"enter";
export function createKeypad(onKey: (key: Key) => void): HTMLElement;
```

- Order: `1 2 3 / 4 5 6 / 7 8 9 / clear 0 back`, then `enter` on its own row. Labels
  `CLEAR` (yellow), `BACK` (red), `ENTER` (green); digits grey.
- Colour is never the only cue: `aria-label` on every key (`Clear entry`,
  `Delete last character`, `Enter and confirm`).
- One key press produces exactly one `onKey` call: `pointerdown` for feedback, `click`
  for the action.

## 5. Multi-tap

```ts
// src/client/ui/multitap.ts
export interface MultiTapState {
  text: string;                 // committed characters
  pendingKey: string | null;    // key currently cycling, e.g. "2"
  pendingIndex: number;         // 0-based index into the key's letters
  pendingAtMs: number | null;   // when pendingIndex last advanced
}
export function createMultiTap(): MultiTapState;
export function press(state: MultiTapState, key: string, nowMs: number): MultiTapState;
export function resolve(state: MultiTapState, nowMs: number): MultiTapState; // commit an expired pending
export function backspace(state: MultiTapState): MultiTapState;
export function clearAll(): MultiTapState;
export function shownText(state: MultiTapState): string; // text + pending letter
```

Rules, all pinned by tests:

1. Mapping `2 ABC`, `3 DEF`, `4 GHI`, `5 JKL`, `6 MNO`, `7 PQRS`, `8 TUV`, `9 WXYZ`.
   `0` and `1` are ignored for text.
2. Same key again within `MULTITAP_WINDOW_MS` (800 ms) advances the pending letter,
   wrapping (`P→Q→R→S→P`).
3. A different key commits the pending letter and starts a new one; no timing needed.
4. `resolve` commits a pending letter once the window has passed, so waiting never
   loses it.
5. `backspace` deletes the pending letter if there is one, else the last committed
   character.
6. `clearAll()` empties everything.
7. Committed plus pending never exceeds `MAX_NAME_LENGTH` (20); further keys are
   ignored at the cap.

Display is `shownText()` plus `_` as the caret: `US` with a pending `E` shows `USE_`.
`main.ts` runs one `setInterval(…, 200)` for the whole app that calls
`resolve(state, Date.now())` and re-renders only when the state object changed.

## 6. Screens in this slice

Placeholders with their final layout, so slices 04 and 06 only fill in behaviour:

| Screen | Title | Lines | Input |
|--------|-------|-------|-------|
| `login` | `WELCOME` | `Enter your name`, `Use the keypad. 3 to 20 letters.` | multi-tap echo |
| `home` | `WELCOME, <NAME>` | `Balance`, then the formatted balance on its own line | none |
| `amount` | `WITHDRAWAL` / `DEPOSIT` | `Enter amount in dollars`, `Balance: $…` | amount digits |
| `message` | `state.message.title` | `state.message.body` | none |

`home` and `amount` show `$0.00` here because there is no API client yet. The balance
is formatted on the client for display only, with the same `Intl` call as the server;
the value always comes from the server and the client never computes a new balance.

## 7. `main.ts`

Reads `#app`, builds `section.atm > div.atm__screen#display`, `nav.atm__keypad` and
`footer.atm__hint` (`Your name is used only in the log.`); creates the initial state on
`login` and renders; attaches the keypad, dispatching `reduce`; installs the 200 ms
resolve/render interval. Nothing is logged to the console in normal operation.
`index.html` loads `<script type="module" src="/js/client/main.js"></script>` after the
markup, so `main.ts` may assume the elements exist.

## 8. CSS requirements

- Page: white background, system sans-serif, ATM centred, `min-height: 100dvh`.
- `.atm`: dark slate frame, generous padding, `border-radius: 18px`, subtle shadow.
- `.atm__screen`: monospace, dark green background, pale green text, fixed min-height,
  `white-space: pre-wrap`, scrolls if long, `aria-live="polite"` so errors are
  announced.
- Keypad: `grid-template-columns: repeat(3, 1fr)`, `gap: 10px`, ENTER spans three
  columns.
- Keys: digits `#d8dde3`, CLEAR `#f2c744` black text, BACK `#c0392b` white text, ENTER
  `#27ae60` white text; hover/active darken by 8 %; `:focus-visible` gets a 2 px
  outline.
- No animation longer than 150 ms; nothing moves while a transaction is in flight.

## 9. Acceptance criteria

- [ ] `npm run build` emits `public/js/client/main.js` and friends; `npm start` renders
      the ATM in §1.
- [ ] `2` three times slowly gives `A A A`; three times quickly gives `C`; `7` five
      times quickly wraps back to `P`.
- [ ] CLEAR empties the entry; BACK removes one character; ENTER with `AB` shows
      `Name must be at least 3 letters.` and stays on login.
- [ ] ENTER with `ABC` goes to home and the title reads `WELCOME, ABC`.
- [ ] BACK on the amount screen deletes a digit, and on an empty entry returns home.
- [ ] On a 375 px viewport the ATM fits without horizontal scrolling and every key is
      thumb-reachable.
- [ ] Typing in a text field does not operate the ATM. ATM should never be operated by a keyboard
- [ ] `npm test` passes; no console errors in the browser.
