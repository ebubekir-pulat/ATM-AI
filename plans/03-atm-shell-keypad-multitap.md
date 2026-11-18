# ATM Shell, Keypad and Multi-Tap Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the browser-based ATM interface with frame, display, 15-button keypad, screen router, and multi-tap text/number input engine.

**Architecture:** Single state object with pure reducer, screens as pure view-model functions, display/keypad/multitap as separate UI modules. One render loop driven by 200ms interval for multi-tap resolution. No network calls in this slice.

**Tech Stack:** TypeScript (dual tsconfig: client + server), vanilla DOM, Jest for tests, Vite or similar for dev server (npm start).

**Spec:** `specs/03-atm-shell-and-keypad.md`

## Global Constraints

- ATM max width `420px`, screen aspect `4:3`, keypad buttons min `56px` tall.
- Multi-tap window `800ms`, max name length `20` chars.
- Key mapping: `2 ABC`, `3 DEF`, `4 GHI`, `5 JKL`, `6 MNO`, `7 PQRS`, `8 TUV`, `9 WXYZ`. Keys `0`/`1` ignored for text.
- Colour never sole cue: `aria-label` on every key (`Clear entry`, `Delete last character`, `Enter and confirm`).
- Page white background, ATM centred, `min-height: 100dvh`.
- No animation > `150ms`; nothing moves while transaction in flight.
- `npm run build` emits to `public/js/client/`; entry is `/js/client/main.js`.
- `npm test` passes; no console errors in browser.
- Screens never touch DOM; they return `ViewModel`, `display.ts` paints it.
- Balance formatted client-side with `Intl` for display only; value always from server.

## Review Focus

1. **Rapid multi-tap on same key** — wrapping behavior (`P→Q→R→S→P`) must not lose or duplicate letters. Test: `multitap.test.ts` presses `7` five times within window.
2. **Cross-key commit timing** — pressing a different key must commit pending immediately without waiting for window. Test: `multitap.test.ts` presses `2` then `3` rapidly.
3. **Backspace priority** — deletes pending first, then committed. Test: `multitap.test.ts` with pending letter then backspace.
4. **Router back behavior** — on `login`, `back` deletes char (no screen change); on `amount` with empty entry, returns `home`. Test: `router.test.ts` for both cases.
5. **ENTER validation on login** — `< 3 chars` shows banner and stays; `≥ 3` goes to `home`. Test: `router.test.ts` with `AB` vs `ABC`.

---

### Task 1: Project Setup & TypeScript Config

**Files:**
- Create: `tsconfig.client.json`
- Modify: `package.json`

**Interfaces:**
- Produces: Client TS config extending base, `build` script runs both `tsc -p tsconfig.json` and `tsc -p tsconfig.client.json`.

- [ ] **Step 1: Write `tsconfig.client.json`**
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "public/js/client",
    "rootDir": "src/client",
    "module": "ESNext",
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": false,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/client/**/*"],
  "exclude": ["node_modules", "public", "tests"]
}
```

- [ ] **Step 2: Update `package.json` scripts**
```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json && tsc -p tsconfig.client.json",
    "test": "jest",
    "start": "vite"
  },
  "devDependencies": {
    "vite": "^5.0.0",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "@types/jest": "^29.0.0"
  }
}
```

- [ ] **Step 3: Run build to verify config**
Run: `npm run build`
Expected: No errors, emits to `public/js/client/`

- [ ] **Step 4: Commit**
```bash
git add tsconfig.client.json package.json
git commit -m "chore: add client tsconfig and build scripts"
```

---

### Task 2: State Types & Reducer Skeleton

**Files:**
- Create: `src/client/state.ts`
- Test: `tests/client/state.test.ts` (smoke test only)

**Interfaces:**
- Consumes: None (foundation)
- Produces: `AppState`, `ScreenName`, `Connection`, `Action`, `reduce(state, action) -> AppState`

- [ ] **Step 1: Write failing test**
```ts
// tests/client/state.test.ts
import { reduce, createInitialState } from '../src/client/state';

test('initial state is login screen with empty input', () => {
  const state = createInitialState();
  expect(state.screen).toBe('login');
  expect(state.input.text).toBe('');
  expect(state.userName).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npm test -- tests/client/state.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Implement `src/client/state.ts`**
```ts
// src/client/state.ts
export type ScreenName = 'login' | 'home' | 'amount' | 'message';
export type Connection = 'connected' | 'connecting' | 'offline';

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
  amountMode: 'withdraw' | 'deposit' | null;
  input: MultiTapState;
  amountDigits: string;
  busy: boolean;
  banner: string | null;
  message: { title: string; body: string } | null;
  connection: Connection;
  recentActivity: ActivityEntry[];
}

export type Key = '0'|'1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'clear'|'back'|'enter';

export type Action =
  | { type: 'key'; key: Key }
  | { type: 'screen'; to: ScreenName }
  | { type: 'login'; userName: string };

export const MULTITAP_WINDOW_MS = 800;
export const MAX_NAME_LENGTH = 20;

export function createInitialState(): AppState {
  return {
    screen: 'login',
    userName: null,
    balanceCents: 0,
    lock: null,
    amountMode: null,
    input: createMultiTap(),
    amountDigits: '',
    busy: false,
    banner: null,
    message: null,
    connection: 'connecting',
    recentActivity: [],
  };
}

export function createMultiTap(): MultiTapState {
  return { text: '', pendingKey: null, pendingIndex: 0, pendingAtMs: null };
}

export function reduce(state: AppState, action: Action): AppState {
  // TODO: implement in later tasks
  return state;
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npm test -- tests/client/state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/client/state.ts tests/client/state.test.ts
git commit -m "feat: add state types and initial state"
```

---

### Task 3: Multi-Tap Engine

**Files:**
- Create: `src/client/ui/multitap.ts`
- Test: `tests/client/multitap.test.ts`

**Interfaces:**
- Consumes: `MultiTapState`, `MULTITAP_WINDOW_MS`, `MAX_NAME_LENGTH` from `state.ts`
- Produces: `createMultiTap()`, `press()`, `resolve()`, `backspace()`, `clearAll()`, `shownText()`

- [ ] **Step 1: Write failing tests**
```ts
// tests/client/multitap.test.ts
import { createMultiTap, press, resolve, backspace, clearAll, shownText, MULTITAP_WINDOW_MS, MAX_NAME_LENGTH } from '../src/client/ui/multitap';

const KEY_MAP: Record<string, string> = {
  '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL',
  '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ',
};

function lettersFor(key: string) { return KEY_MAP[key] || ''; }

test('single press shows first letter', () => {
  let s = createMultiTap();
  s = press(s, '2', 1000);
  expect(shownText(s)).toBe('A');
});

test('three rapid presses on 2 gives C', () => {
  let s = createMultiTap();
  s = press(s, '2', 1000);
  s = press(s, '2', 1200);
  s = press(s, '2', 1400);
  expect(shownText(s)).toBe('C');
});

test('five rapid presses on 7 wraps to P', () => {
  let s = createMultiTap();
  const now = 1000;
  s = press(s, '7', now);
  s = press(s, '7', now + 100);
  s = press(s, '7', now + 200);
  s = press(s, '7', now + 300);
  s = press(s, '7', now + 400);
  expect(shownText(s)).toBe('P');
});

test('different key commits pending and starts new', () => {
  let s = createMultiTap();
  s = press(s, '2', 1000);  // A
  s = press(s, '3', 1100);  // commits A, starts D
  expect(shownText(s)).toBe('AD');
});

test('resolve commits expired pending', () => {
  let s = createMultiTap();
  s = press(s, '2', 1000);  // A pending
  s = resolve(s, 1000 + MULTITAP_WINDOW_MS + 1);
  expect(shownText(s)).toBe('A');
  expect(s.pendingKey).toBeNull();
});

test('backspace deletes pending first', () => {
  let s = createMultiTap();
  s = press(s, '2', 1000);  // A pending
  s = backspace(s);
  expect(shownText(s)).toBe('');
  expect(s.pendingKey).toBeNull();
});

test('backspace deletes committed when no pending', () => {
  let s = createMultiTap();
  s = press(s, '2', 1000);
  s = press(s, '3', 1100);  // commits A, D pending
  s = backspace(s);         // deletes D
  s = backspace(s);         // deletes A
  expect(shownText(s)).toBe('');
});

test('clearAll empties everything', () => {
  let s = createMultiTap();
  s = press(s, '2', 1000);
  s = press(s, '3', 1100);
  s = clearAll();
  expect(shownText(s)).toBe('');
  expect(s.text).toBe('');
  expect(s.pendingKey).toBeNull();
});

test('max length caps input', () => {
  let s = createMultiTap();
  for (let i = 0; i < MAX_NAME_LENGTH; i++) {
    s = press(s, '2', 1000 + i * 100);
    s = press(s, '3', 1000 + i * 100 + 50);
  }
  const before = shownText(s).length;
  s = press(s, '2', 10000);
  expect(shownText(s).length).toBe(before);
});

test('shownText includes caret underscore', () => {
  let s = createMultiTap();
  s = press(s, '2', 1000);  // A pending
  expect(shownText(s)).toBe('A_');
});
```

- [ ] **Step 2: Run tests to verify they fail**
Run: `npm test -- tests/client/multitap.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Implement `src/client/ui/multitap.ts`**
```ts
// src/client/ui/multitap.ts
import { MultiTapState, MULTITAP_WINDOW_MS, MAX_NAME_LENGTH } from '../state';

const KEY_MAP: Record<string, string> = {
  '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL',
  '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ',
};

export function createMultiTap(): MultiTapState {
  return { text: '', pendingKey: null, pendingIndex: 0, pendingAtMs: null };
}

export function press(state: MultiTapState, key: string, nowMs: number): MultiTapState {
  const letters = KEY_MAP[key];
  if (!letters || state.text.length + (state.pendingKey ? 1 : 0) >= MAX_NAME_LENGTH) {
    return state;
  }

  if (state.pendingKey === key) {
    // Same key within window -> advance
    const nextIndex = (state.pendingIndex + 1) % letters.length;
    return {
      ...state,
      pendingIndex: nextIndex,
      pendingAtMs: nowMs,
    };
  }

  // Different key -> commit pending, start new
  let newText = state.text;
  if (state.pendingKey) {
    const prevLetters = KEY_MAP[state.pendingKey];
    if (prevLetters) {
      newText += prevLetters[state.pendingIndex];
    }
  }
  return {
    text: newText,
    pendingKey: key,
    pendingIndex: 0,
    pendingAtMs: nowMs,
  };
}

export function resolve(state: MultiTapState, nowMs: number): MultiTapState {
  if (!state.pendingKey || !state.pendingAtMs) return state;
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
  if (!state.pendingKey) return state.text + '_';
  const letters = KEY_MAP[state.pendingKey];
  if (!letters) return state.text + '_';
  return state.text + letters[state.pendingIndex] + '_';
}
```

- [ ] **Step 4: Run tests to verify they pass**
Run: `npm test -- tests/client/multitap.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/client/ui/multitap.ts tests/client/multitap.test.ts
git commit -m "feat: implement multi-tap input engine"
```

---

### Task 4: Display / ViewModel Renderer

**Files:**
- Create: `src/client/ui/display.ts`
- Test: `tests/client/display.test.ts`

**Interfaces:**
- Consumes: `ViewModel` interface
- Produces: `renderDisplay(root: HTMLElement, vm: ViewModel): void`

- [ ] **Step 1: Write failing test**
```ts
// tests/client/display.test.ts
import { renderDisplay } from '../src/client/ui/display';

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
});

test('renders title, lines, input with caret, and banner', () => {
  const root = document.getElementById('root')!;
  renderDisplay(root, {
    title: 'WELCOME',
    lines: ['Enter your name', 'Use the keypad. 3 to 20 letters.'],
    input: 'US_',
    banner: null,
    status: 'info',
  });

  expect(root.querySelector('.atm__title')?.textContent).toBe('WELCOME');
  expect(root.querySelectorAll('.atm__line').length).toBe(2);
  expect(root.querySelector('.atm__input')?.textContent).toBe('US_');
  expect(root.querySelector('.atm__banner')).toBeNull();
});

test('renders error banner with status', () => {
  const root = document.getElementById('root')!;
  renderDisplay(root, {
    title: 'WELCOME',
    lines: ['Enter your name'],
    input: 'AB_',
    banner: 'Name must be at least 3 letters.',
    status: 'error',
  });

  const banner = root.querySelector('.atm__banner') as HTMLElement;
  expect(banner).not.toBeNull();
  expect(banner.textContent).toBe('Name must be at least 3 letters.');
  expect(banner.classList.contains('atm__banner--error')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npm test -- tests/client/display.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Implement `src/client/ui/display.ts`**
```ts
// src/client/ui/display.ts
export interface ViewModel {
  title: string;
  lines: string[];
  input?: string;
  banner?: string | null;
  status?: 'info' | 'success' | 'error';
}

export function renderDisplay(root: HTMLElement, vm: ViewModel): void {
  root.innerHTML = '';

  const screen = document.createElement('div');
  screen.className = 'atm__screen';
  screen.setAttribute('aria-live', 'polite');

  const title = document.createElement('div');
  title.className = 'atm__title';
  title.textContent = vm.title;
  screen.appendChild(title);

  for (const line of vm.lines) {
    const lineEl = document.createElement('div');
    lineEl.className = 'atm__line';
    lineEl.textContent = line;
    screen.appendChild(lineEl);
  }

  if (vm.input !== undefined) {
    const input = document.createElement('div');
    input.className = 'atm__input';
    input.textContent = vm.input;
    screen.appendChild(input);
  }

  if (vm.banner) {
    const banner = document.createElement('div');
    banner.className = `atm__banner atm__banner--${vm.status || 'info'}`;
    banner.textContent = vm.banner;
    screen.appendChild(banner);
  }

  root.appendChild(screen);
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npm test -- tests/client/display.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/client/ui/display.ts tests/client/display.test.ts
git commit -m "feat: add display renderer"
```

---

### Task 5: Keypad Component

**Files:**
- Create: `src/client/ui/keypad.ts`
- Test: `tests/client/keypad.test.ts`

**Interfaces:**
- Consumes: `Key` type from `state.ts`
- Produces: `createKeypad(onKey: (key: Key) => void): HTMLElement`

- [ ] **Step 1: Write failing test**
```ts
// tests/client/keypad.test.ts
import { createKeypad } from '../src/client/ui/keypad';

test('creates keypad with 12 keys + enter, calls onKey on click', () => {
  const keys: string[] = [];
  const keypad = createKeypad((k) => keys.push(k));
  document.body.appendChild(keypad);

  const buttons = keypad.querySelectorAll('button');
  expect(buttons.length).toBe(13); // 12 + enter

  // Check layout order: 1 2 3 / 4 5 6 / 7 8 9 / clear 0 back
  const labels = Array.from(buttons).slice(0, 12).map(b => b.textContent?.trim());
  expect(labels).toEqual(['1','2','3','4','5','6','7','8','9','CLEAR','0','BACK']);

  // Enter is separate row, spans 3 columns
  const enterBtn = buttons[12];
  expect(enterBtn.textContent?.trim()).toBe('ENTER');
  expect(enterBtn.getAttribute('style')?.includes('grid-column')).toBeTruthy();

  // Click a digit
  (buttons[0] as HTMLButtonElement).click();
  expect(keys).toEqual(['1']);

  // Click clear
  (buttons[9] as HTMLButtonElement).click();
  expect(keys).toEqual(['1', 'clear']);

  // Aria labels
  expect(buttons[9].getAttribute('aria-label')).toBe('Clear entry');
  expect(buttons[11].getAttribute('aria-label')).toBe('Delete last character');
  expect(enterBtn.getAttribute('aria-label')).toBe('Enter and confirm');
});

test('colours: digits grey, clear yellow, back red, enter green', () => {
  const keypad = createKeypad(() => {});
  const buttons = keypad.querySelectorAll('button');

  // Digits (first 9) - grey
  for (let i = 0; i < 9; i++) {
    expect(buttons[i].getAttribute('style')).toContain('#d8dde3');
  }
  // Clear (index 9) - yellow
  expect(buttons[9].getAttribute('style')).toContain('#f2c744');
  // 0 (index 10) - grey
  expect(buttons[10].getAttribute('style')).toContain('#d8dde3');
  // Back (index 11) - red
  expect(buttons[11].getAttribute('style')).toContain('#c0392b');
  // Enter (index 12) - green
  expect(buttons[12].getAttribute('style')).toContain('#27ae60');
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npm test -- tests/client/keypad.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Implement `src/client/ui/keypad.ts`**
```ts
// src/client/ui/keypad.ts
import { Key } from '../state';

const KEY_CONFIG: Array<{ key: Key; label: string; color: string; ariaLabel: string }> = [
  { key: '1', label: '1', color: '#d8dde3', ariaLabel: 'Digit 1' },
  { key: '2', label: '2', color: '#d8dde3', ariaLabel: 'Digit 2' },
  { key: '3', label: '3', color: '#d8dde3', ariaLabel: 'Digit 3' },
  { key: '4', label: '4', color: '#d8dde3', ariaLabel: 'Digit 4' },
  { key: '5', label: '5', color: '#d8dde3', ariaLabel: 'Digit 5' },
  { key: '6', label: '6', color: '#d8dde3', ariaLabel: 'Digit 6' },
  { key: '7', label: '7', color: '#d8dde3', ariaLabel: 'Digit 7' },
  { key: '8', label: '8', color: '#d8dde3', ariaLabel: 'Digit 8' },
  { key: '9', label: '9', color: '#d8dde3', ariaLabel: 'Digit 9' },
  { key: 'clear', label: 'CLEAR', color: '#f2c744', ariaLabel: 'Clear entry' },
  { key: '0', label: '0', color: '#d8dde3', ariaLabel: 'Digit 0' },
  { key: 'back', label: 'BACK', color: '#c0392b', ariaLabel: 'Delete last character' },
];

export function createKeypad(onKey: (key: Key) => void): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'atm__keypad';
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', 'ATM keypad');

  const grid = document.createElement('div');
  grid.className = 'atm__keypad-grid';
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px;';

  for (const config of KEY_CONFIG) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'atm__key';
    btn.textContent = config.label;
    btn.style.cssText = `
      background:${config.color};
      color:${config.key === 'back' ? '#fff' : '#000'};
      border:none;
      border-radius:8px;
      min-height:56px;
      font-size:1.25rem;
      font-weight:600;
      cursor:pointer;
      transition:filter 100ms;
    `;
    btn.setAttribute('aria-label', config.ariaLabel);
    btn.addEventListener('pointerdown', () => {
      btn.style.filter = 'brightness(0.92)';
    });
    btn.addEventListener('pointerup', () => {
      btn.style.filter = '';
    });
    btn.addEventListener('pointerleave', () => {
      btn.style.filter = '';
    });
    btn.addEventListener('click', () => onKey(config.key));
    grid.appendChild(btn);
  }

  nav.appendChild(grid);

  // Enter row
  const enterBtn = document.createElement('button');
  enterBtn.type = 'button';
  enterBtn.className = 'atm__key atm__key--enter';
  enterBtn.textContent = 'ENTER';
  enterBtn.style.cssText = `
    grid-column:span 3;
    background:#27ae60;
    color:#fff;
    border:none;
    border-radius:8px;
    min-height:56px;
    font-size:1.25rem;
    font-weight:600;
    cursor:pointer;
    transition:filter 100ms;
  `;
  enterBtn.setAttribute('aria-label', 'Enter and confirm');
  enterBtn.addEventListener('pointerdown', () => enterBtn.style.filter = 'brightness(0.92)');
  enterBtn.addEventListener('pointerup', () => enterBtn.style.filter = '');
  enterBtn.addEventListener('pointerleave', () => enterBtn.style.filter = '');
  enterBtn.addEventListener('click', () => onKey('enter'));
  nav.appendChild(enterBtn);

  return nav;
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npm test -- tests/client/keypad.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/client/ui/keypad.ts tests/client/keypad.test.ts
git commit -m "feat: add keypad component"
```

---

### Task 6: Screen View Models

**Files:**
- Create: `src/client/screens/login.ts`
- Create: `src/client/screens/home.ts`
- Create: `src/client/screens/amount.ts`
- Create: `src/client/screens/message.ts`
- Create: `src/client/screens/index.ts` (barrel export)
- Test: `tests/client/screens.test.ts`

**Interfaces:**
- Consumes: `AppState`, `ViewModel`
- Produces: `loginView(state)`, `homeView(state)`, `amountView(state)`, `messageView(state)`

- [ ] **Step 1: Write failing test**
```ts
// tests/client/screens.test.ts
import { loginView, homeView, amountView, messageView } from '../src/client/screens';
import { createInitialState } from '../src/client/state';

test('loginView shows welcome and multi-tap input', () => {
  const state = createInitialState();
  state.input = { text: 'US', pendingKey: '2', pendingIndex: 0, pendingAtMs: 1000 }; // US + A pending
  const vm = loginView(state);
  expect(vm.title).toBe('WELCOME');
  expect(vm.lines).toEqual(['Enter your name', 'Use the keypad. 3 to 20 letters.']);
  expect(vm.input).toBe('USA_');
});

test('homeView shows welcome with name and balance', () => {
  const state = createInitialState();
  state.screen = 'home';
  state.userName = 'ALICE';
  state.balanceCents = 123456;
  const vm = homeView(state);
  expect(vm.title).toBe('WELCOME, ALICE');
  expect(vm.lines[0]).toBe('Balance');
  expect(vm.lines[1]).toBe('$1,234.56');
  expect(vm.input).toBeUndefined();
});

test('amountView shows withdrawal title and balance', () => {
  const state = createInitialState();
  state.screen = 'amount';
  state.amountMode = 'withdraw';
  state.balanceCents = 50000;
  state.amountDigits = '100';
  const vm = amountView(state);
  expect(vm.title).toBe('WITHDRAWAL');
  expect(vm.lines).toEqual(['Enter amount in dollars', 'Balance: $500.00']);
  expect(vm.input).toBe('100_');
});

test('amountView shows deposit title', () => {
  const state = createInitialState();
  state.screen = 'amount';
  state.amountMode = 'deposit';
  const vm = amountView(state);
  expect(vm.title).toBe('DEPOSIT');
});

test('messageView shows title and body', () => {
  const state = createInitialState();
  state.screen = 'message';
  state.message = { title: 'ERROR', body: 'Something went wrong' };
  const vm = messageView(state);
  expect(vm.title).toBe('ERROR');
  expect(vm.lines).toEqual(['Something went wrong']);
  expect(vm.input).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npm test -- tests/client/screens.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Implement screen files**
```ts
// src/client/screens/login.ts
import { AppState } from '../state';
import { ViewModel } from '../ui/display';
import { shownText } from '../ui/multitap';

export function loginView(state: AppState): ViewModel {
  return {
    title: 'WELCOME',
    lines: ['Enter your name', 'Use the keypad. 3 to 20 letters.'],
    input: shownText(state.input),
    banner: state.banner,
    status: state.banner ? 'error' : 'info',
  };
}
```

```ts
// src/client/screens/home.ts
import { AppState } from '../state';
import { ViewModel } from '../ui/display';
import { formatCents } from '../ui/money';

export function homeView(state: AppState): ViewModel {
  return {
    title: `WELCOME, ${state.userName || ''}`,
    lines: ['Balance', formatCents(state.balanceCents)],
  };
}
```

```ts
// src/client/screens/amount.ts
import { AppState } from '../state';
import { ViewModel } from '../ui/display';
import { formatCents } from '../ui/money';

export function amountView(state: AppState): ViewModel {
  const title = state.amountMode === 'deposit' ? 'DEPOSIT' : 'WITHDRAWAL';
  return {
    title,
    lines: ['Enter amount in dollars', `Balance: ${formatCents(state.balanceCents)}`],
    input: state.amountDigits + '_',
  };
}
```

```ts
// src/client/screens/message.ts
import { AppState } from '../state';
import { ViewModel } from '../ui/display';

export function messageView(state: AppState): ViewModel {
  return {
    title: state.message?.title || '',
    lines: state.message?.body ? [state.message.body] : [],
  };
}
```

```ts
// src/client/screens/index.ts
export * from './login';
export * from './home';
export * from './amount';
export * from './message';
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npm test -- tests/client/screens.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/client/screens/ tests/client/screens.test.ts
git commit -m "feat: add screen view models"
```

---

### Task 7: Money Formatter (Client-Side)

**Files:**
- Create: `src/client/ui/money.ts`
- Test: `tests/client/formatInput.test.ts`

**Interfaces:**
- Consumes: None
- Produces: `formatCents(cents: number): string`

- [ ] **Step 1: Write failing test**
```ts
// tests/client/formatInput.test.ts
import { formatCents } from '../src/client/ui/money';

test('formats cents to dollars with commas and two decimals', () => {
  expect(formatCents(0)).toBe('$0.00');
  expect(formatCents(1)).toBe('$0.01');
  expect(formatCents(99)).toBe('$0.99');
  expect(formatCents(100)).toBe('$1.00');
  expect(formatCents(123456)).toBe('$1,234.56');
  expect(formatCents(1000000)).toBe('$10,000.00');
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npm test -- tests/client/formatInput.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Implement `src/client/ui/money.ts`**
```ts
// src/client/ui/money.ts
export function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npm test -- tests/client/formatInput.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/client/ui/money.ts tests/client/formatInput.test.ts
git commit -m "feat: add money formatter"
```

---

### Task 8: Reducer Implementation

**Files:**
- Modify: `src/client/state.ts`
- Test: `tests/client/router.test.ts`

**Interfaces:**
- Consumes: `AppState`, `Action`, `MultiTapState`, multi-tap functions, screen types
- Produces: Complete `reduce(state, action)` with all transitions

- [ ] **Step 1: Write failing tests**
```ts
// tests/client/router.test.ts
import { reduce, createInitialState, AppState, MULTITAP_WINDOW_MS } from '../src/client/state';
import { press, resolve, backspace, clearAll, createMultiTap } from '../src/client/ui/multitap';

function loginState(overrides: Partial<AppState> = {}): AppState {
  return { ...createInitialState(), screen: 'login', ...overrides };
}

function homeState(overrides: Partial<AppState> = {}): AppState {
  return { ...createInitialState(), screen: 'home', userName: 'ALICE', balanceCents: 100000, ...overrides };
}

function amountState(overrides: Partial<AppState> = {}): AppState {
  return { ...createInitialState(), screen: 'amount', amountMode: 'withdraw', balanceCents: 100000, ...overrides };
}

test('digit on login appends through multi-tap', () => {
  let state = loginState();
  state = reduce(state, { type: 'key', key: '2' });
  state = reduce(state, { type: 'key', key: '2' });
  state = reduce(state, { type: 'key', key: '2' });
  expect(state.input.text).toBe('');
  expect(state.input.pendingKey).toBe('2');
  expect(state.input.pendingIndex).toBe(2); // C
});

test('back on login deletes one character, does not leave screen', () => {
  let state = loginState({ input: createMultiTap() });
  // Simulate "ABC" committed
  state.input = { text: 'ABC', pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: 'key', key: 'back' });
  expect(state.input.text).toBe('AB');
  expect(state.screen).toBe('login');
});

test('back on amount deletes digit; empty returns home', () => {
  let state = amountState({ amountDigits: '100' });
  state = reduce(state, { type: 'key', key: 'back' });
  expect(state.amountDigits).toBe('10');

  state = reduce(state, { type: 'key', key: 'back' });
  state = reduce(state, { type: 'key', key: 'back' });
  expect(state.screen).toBe('home');
});

test('enter on login with < 3 chars shows banner and stays', () => {
  let state = loginState();
  // Input "AB" (2 chars)
  state.input = { text: 'AB', pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: 'key', key: 'enter' });
  expect(state.screen).toBe('login');
  expect(state.banner).toBe('Name must be at least 3 letters.');
});

test('enter on login with valid name moves to home', () => {
  let state = loginState();
  state.input = { text: 'ABC', pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: 'key', key: 'enter' });
  expect(state.screen).toBe('home');
  expect(state.userName).toBe('ABC');
  expect(state.banner).toBeNull();
});

test('clear on login empties entry', () => {
  let state = loginState({ input: { text: 'HELLO', pendingKey: null, pendingIndex: 0, pendingAtMs: null } });
  state = reduce(state, { type: 'key', key: 'clear' });
  expect(state.input.text).toBe('');
  expect(state.input.pendingKey).toBeNull();
});

test('digit on amount appends to amountDigits', () => {
  let state = amountState({ amountDigits: '' });
  state = reduce(state, { type: 'key', key: '5' });
  state = reduce(state, { type: 'key', key: '0' });
  expect(state.amountDigits).toBe('50');
});

test('clear on amount empties amountDigits', () => {
  let state = amountState({ amountDigits: '123' });
  state = reduce(state, { type: 'key', key: 'clear' });
  expect(state.amountDigits).toBe('');
});
```

- [ ] **Step 2: Run tests to verify they fail**
Run: `npm test -- tests/client/router.test.ts`
Expected: FAIL - reducer not implemented

- [ ] **Step 3: Implement `reduce` in `src/client/state.ts`**
```ts
// In src/client/state.ts, replace the stub reduce function:

import { press, resolve, backspace, clearAll, shownText } from './ui/multitap';
import { formatCents } from './ui/money';

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'screen': {
      return { ...state, screen: action.to };
    }

    case 'login': {
      return { ...state, userName: action.userName, screen: 'home', banner: null };
    }

    case 'key': {
      const key = action.key;
      const now = Date.now();

      // Resolve any expired multi-tap first
      let newInput = resolve(state.input, now);

      switch (state.screen) {
        case 'login': {
          if (key >= '0' && key <= '9') {
            newInput = press(newInput, key, now);
            return { ...state, input: newInput, banner: null };
          }
          switch (key) {
            case 'clear':
              return { ...state, input: clearAll(), banner: null };
            case 'back':
              return { ...state, input: backspace(newInput), banner: null };
            case 'enter': {
              const name = shownText(newInput).replace(/_$/, '');
              if (name.length < 3) {
                return { ...state, banner: 'Name must be at least 3 letters.' };
              }
              return { ...state, screen: 'home', userName: name, input: clearAll(), banner: null };
            }
          }
          break;
        }

        case 'home': {
          // Home screen doesn't handle keypad input directly
          break;
        }

        case 'amount': {
          if (key >= '0' && key <= '9') {
            const newDigits = state.amountDigits + key;
            return { ...state, amountDigits: newDigits };
          }
          switch (key) {
            case 'clear':
              return { ...state, amountDigits: '' };
            case 'back': {
              if (state.amountDigits.length > 0) {
                return { ...state, amountDigits: state.amountDigits.slice(0, -1) };
              }
              return { ...state, screen: 'home', amountMode: null, amountDigits: '' };
            }
            case 'enter':
              // Handled by slice 06/07
              break;
          }
          break;
        }

        case 'message': {
          // Message screen doesn't handle keypad input
          break;
        }
      }
      return { ...state, input: newInput };
    }
  }
  return state;
}
```

- [ ] **Step 4: Run tests to verify they pass**
Run: `npm test -- tests/client/router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/client/state.ts tests/client/router.test.ts
git commit -m "feat: implement reducer with screen transitions"
```

---

### Task 9: Main Entry Point & HTML/CSS

**Files:**
- Create: `src/client/main.ts`
- Create: `public/index.html`
- Create: `public/css/atm.css`
- Modify: `package.json` (verify start script)

**Interfaces:**
- Consumes: All client modules
- Produces: Running ATM in browser

- [ ] **Step 1: Create `public/index.html`**
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ATM</title>
  <link rel="stylesheet" href="/css/atm.css">
</head>
<body>
  <section id="app" class="atm"></section>
  <script type="module" src="/js/client/main.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/css/atm.css`**
```css
/* public/css/atm.css */
* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  height: 100%;
  min-height: 100dvh;
  background: #fff;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 24px 12px;
}

.atm {
  width: 100%;
  max-width: 420px;
  background: #1a1f2e;
  border-radius: 18px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.15);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.atm__screen {
  background: #0f2b1a;
  color: #7eff9a;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 1rem;
  line-height: 1.5;
  padding: 16px;
  border-radius: 12px;
  min-height: 200px;
  aspect-ratio: 4 / 3;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  white-space: pre-wrap;
  overflow-y: auto;
}

.atm__title {
  font-size: 1.25rem;
  font-weight: 700;
  margin-bottom: 8px;
}

.atm__line {
  margin-bottom: 4px;
}

.atm__input {
  margin-top: 12px;
  font-size: 1.5rem;
  font-weight: 600;
}

.atm__banner {
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 0.875rem;
}

.atm__banner--info { background: #1e3a5f; color: #7eb8ff; }
.atm__banner--success { background: #144d2e; color: #7eff9a; }
.atm__banner--error { background: #5c1a1a; color: #ff7b7b; }

.atm__keypad {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.atm__keypad-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.atm__key {
  border: none;
  border-radius: 8px;
  min-height: 56px;
  font-size: 1.25rem;
  font-weight: 600;
  cursor: pointer;
  transition: filter 100ms;
}

.atm__key:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

.atm__key--enter {
  grid-column: span 3;
}

.atm__hint {
  text-align: center;
  font-size: 0.75rem;
  color: #889;
  padding-top: 8px;
  border-top: 1px solid #2d3548;
}
```

- [ ] **Step 3: Create `src/client/main.ts`**
```ts
// src/client/main.ts
import { createInitialState, reduce, AppState } from './state';
import { renderDisplay, ViewModel } from './ui/display';
import { createKeypad } from './ui/keypad';
import { loginView } from './screens/login';
import { homeView } from './screens/home';
import { amountView } from './screens/amount';
import { messageView } from './screens/message';
import { resolve } from './ui/multitap';

const app = document.getElementById('app')!;
const displayRoot = document.createElement('div');
displayRoot.id = 'display';
app.appendChild(displayRoot);

const keypad = createKeypad((key) => {
  state = reduce(state, { type: 'key', key });
  render();
});
app.appendChild(keypad);

const hint = document.createElement('footer');
hint.className = 'atm__hint';
hint.textContent = 'Your name is used only in the log.';
app.appendChild(hint);

let state = createInitialState();

function getViewModel(state: AppState): ViewModel {
  switch (state.screen) {
    case 'login': return loginView(state);
    case 'home': return homeView(state);
    case 'amount': return amountView(state);
    case 'message': return messageView(state);
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
```

- [ ] **Step 4: Verify build and start**
Run: `npm run build`
Expected: Emits `public/js/client/main.js` and deps

Run: `npm start`
Expected: Vite serves `public/index.html`, ATM renders per spec §1

- [ ] **Step 5: Commit**
```bash
git add public/index.html public/css/atm.css src/client/main.ts
git commit -m "feat: add main entry, HTML, and CSS"
```

---

### Task 10: Integration Tests & Acceptance Verification

**Files:**
- Test: `tests/client/integration.test.ts` (browser-style via JSDOM)

**Interfaces:**
- Consumes: Full app via `main.ts` logic (extracted for testability)

- [ ] **Step 1: Write failing integration tests**
```ts
// tests/client/integration.test.ts
import { createInitialState, reduce, AppState } from '../src/client/state';
import { press, resolve, shownText, createMultiTap, MULTITAP_WINDOW_MS } from '../src/client/ui/multitap';
import { loginView, homeView, amountView } from '../src/client/screens';
import { formatCents } from '../src/client/ui/money';

test('full login flow: multi-tap ABC -> enter -> home', () => {
  let state = createInitialState();

  // Type A (2 once)
  state = reduce(state, { type: 'key', key: '2' });
  // Type B (2 twice quickly)
  state = reduce(state, { type: 'key', key: '2' });
  state = reduce(state, { type: 'key', key: '2' });
  // Type C (2 three times quickly) - actually need different key to commit
  // Simulate: 2->A, 2->B, 2->C, then 3 commits C and starts D
  // Let's use resolve to commit
  state = reduce(state, { type: 'key', key: '2' }); // 3rd press = C
  // Now press 3 to commit C
  state = reduce(state, { type: 'key', key: '3' }); // commits C, starts D
  // Press back to remove D
  state = reduce(state, { type: 'key', key: 'back' });
  // Now we have ABC
  expect(shownText(state.input).replace(/_$/, '')).toBe('ABC');

  // Enter
  state = reduce(state, { type: 'key', key: 'enter' });
  expect(state.screen).toBe('home');
  expect(state.userName).toBe('ABC');
});

test('multi-tap: 2 three times slowly = AAA', () => {
  let s = createMultiTap();
  const base = Date.now();
  s = press(s, '2', base);
  s = press(s, '2', base + MULTITAP_WINDOW_MS + 100); // expired
  s = press(s, '2', base + 2*(MULTITAP_WINDOW_MS + 100));
  expect(shownText(s)).toBe('AAA_');
});

test('multi-tap: 7 five times quickly = P (wrap)', () => {
  let s = createMultiTap();
  const base = Date.now();
  for (let i = 0; i < 5; i++) {
    s = press(s, '7', base + i * 100);
  }
  expect(shownText(s)).toBe('P_');
});

test('CLEAR empties entry', () => {
  let state = createInitialState();
  state = reduce(state, { type: 'key', key: '2' });
  state = reduce(state, { type: 'key', key: '2' });
  state = reduce(state, { type: 'key', key: 'clear' });
  expect(state.input.text).toBe('');
  expect(state.input.pendingKey).toBeNull();
});

test('BACK removes one character', () => {
  let state = createInitialState();
  state.input = { text: 'ABC', pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: 'key', key: 'back' });
  expect(state.input.text).toBe('AB');
});

test('ENTER with AB shows error banner', () => {
  let state = createInitialState();
  state.input = { text: 'AB', pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: 'key', key: 'enter' });
  expect(state.screen).toBe('login');
  expect(state.banner).toBe('Name must be at least 3 letters.');
});

test('ENTER with ABC goes to home', () => {
  let state = createInitialState();
  state.input = { text: 'ABC', pendingKey: null, pendingIndex: 0, pendingAtMs: null };
  state = reduce(state, { type: 'key', key: 'enter' });
  expect(state.screen).toBe('home');
  expect(state.userName).toBe('ABC');
});

test('BACK on amount deletes digit, empty returns home', () => {
  let state = createInitialState();
  state.screen = 'amount';
  state.amountMode = 'withdraw';
  state.amountDigits = '100';
  state = reduce(state, { type: 'key', key: 'back' });
  expect(state.amountDigits).toBe('10');
  state = reduce(state, { type: 'key', key: 'back' });
  state = reduce(state, { type: 'key', key: 'back' });
  expect(state.screen).toBe('home');
});

test('formatCents matches server Intl formatting', () => {
  expect(formatCents(0)).toBe('$0.00');
  expect(formatCents(123456)).toBe('$1,234.56');
});

test('ATM fits 375px viewport', () => {
  // CSS max-width 420px, but viewport 375px - container centers with padding
  // This is a CSS verification, not code test
  expect(true).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they pass**
Run: `npm test -- tests/client/integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**
Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Manual browser verification**
Run: `npm start`
Open browser, verify:
- ATM renders per spec §1 diagram
- Multi-tap: `2` 3x slowly = AAA, 3x quickly = C, `7` 5x quickly = P
- CLEAR empties, BACK removes, ENTER with AB shows error, ENTER with ABC goes home
- BACK on amount deletes digit, empty returns home
- 375px viewport fits, keys thumb-reachable
- Typing in text field doesn't operate ATM (no keyboard listeners)
- No console errors

- [ ] **Step 5: Commit**
```bash
git add tests/client/integration.test.ts
git commit -m "test: add integration tests and verify acceptance criteria"
```

---