# 09 — Verification, Runbook and Traceability

**Depends on:** all previous slices.
**Delivers:** the proof the project does what `specs.txt` asks, the steps to run it
on the Wi-Fi, a demo script, and an honest list of limits.
**Covers:** `specs.txt` §14 (final objective) and the acceptance of every other
section through the table in §4.

---

## 1. Definition of done

The project is finished when all of the following are true, in this order:

1. `npm install && npm run build && npm test` passes from a clean clone on the
   hosting computer.
2. `npm start` serves the ATM on `http://<lan-ip>:3000` and at least one phone on
   the same Wi-Fi can log in and transact.
3. Every item in the manual checklist in §3 is observed and ticked.
4. Every automated test in §5 exists and passes.
5. `specs.txt` has not been modified (`git diff --stat specs/specs.txt` is empty).
6. A reviewer can read `specs/00`–`09` and the code side by side without asking how
   a requirement maps to a file; §4 is the index for that review.

## 2. Automated suites

| Suite | Command | Guards |
|-------|---------|--------|
| Unit (money, time, multi-tap, router) | `npm test` | format and input rules |
| Account and transactions | `npm test` | validation, atomicity, log rows |
| Lock concurrency | `npm test` | one lock at a time under 20 parallel acquires |
| Lock lifecycle | `npm test` | release on success, failure, cancel, sign-out, disconnect, expiry |
| Realtime | `npm test` | broadcast payloads, per-socket `isMine`, reconnect re-sync |
| Retrieval and assistant | `npm test` | prompt contents, no-fabrication fallback, read-only modules |
| API shape | `npm test` | every error is `{ error: { code, message } }` |
| Type check | `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.client.json --noEmit` | strict types |

`npm test` must exit on its own: every test closes its sockets, its server and its
in-memory database. A hanging test run is a defect, not a slow machine.

## 3. Manual multi-client checklist

Run this with two browsers (or a laptop plus a phone) on the same Wi-Fi. Each line is
something a marker can watch happen.

**Shared account (§4, §5)**
- [ ] A logs in, B logs in with another name; both homepages show the same balance.
- [ ] C tries A's name on the login screen: the warning appears while typing and
      ENTER is refused. C picks another name and gets in.
- [ ] A signs out; C can now take A's name. Close C's tab instead of signing out;
      after about a minute the name is free.
- [ ] A deposits `$100`; B's balance rises to match without a reload.
- [ ] A reloads mid-transaction; the balance is still the shared one.

**Locking (§8)**
- [ ] A opens Withdraw and stays on the amount screen. B presses Deposit and reads
      `Another transaction is in progress (A). Try again in a moment.`
- [ ] B can still see the live balance while A holds the lock.
- [ ] B logs out and back in while A holds the lock — still refused, still able to
      see the balance.
- [ ] A presses BACK; B can transact immediately afterwards.
- [ ] A closes the tab on the amount screen; B can transact within a few seconds.
- [ ] A completes a withdrawal; B can transact straight away.
- [ ] Server-side enforcement: with A's session cookie, a direct
      `POST /api/transactions/withdraw` while B holds the lock returns
      `409 LOCK_NOT_HELD`, and the balance is unchanged. (The front end cannot be
      the thing that enforces this.)

**Transactions (§6, §7)**
- [ ] Withdraw exactly the balance → `$0.00`, subsequent withdrawals refused.
- [ ] Withdraw more than the balance → refused, balance unchanged.
- [ ] Deposit `$10,000.00` → accepted; `$10,000.01` → refused.
- [ ] Enter an amount, CLEAR, retype, BACK to empty, return home: no balance change,
      one `transaction_cancelled` entry in the log.
- [ ] Double-tapping ENTER sends one request and writes one entry.

**Log (§9)**
- [ ] `sqlite3 data/atm.db "select local_date, local_time, user_name, event_type, amount_cents from activity_log order by id"`
      shows every login, logout, deposit, withdrawal, failed attempt and cancel, in
      the order they happened.
- [ ] The times match the hosting computer's clock and timezone, not the phone's.
- [ ] Restarting the server leaves the log intact.

**AI (§10)**
- [ ] "Who made the last withdrawal?" names that user, with the amount and time.
- [ ] "How much has been deposited today?" returns a total that matches the log.
- [ ] "Show me the last five transactions." lists five entries that exist.
- [ ] "Why is there $5000 less than this morning?" refers to the actual withdrawal or
      says it cannot tell. It never invents one.
- [ ] "Deposit $100 for me." is refused as read-only; the balance is unchanged.
- [ ] With Ollama stopped, the answer is a clear unavailable message and the ATM
      still works.
- [ ] The `Based on N log entries` list matches the answer.

**Sign out (§11)**
- [ ] Sign out → login screen, a `logout` entry, the other browser is unaffected.
- [ ] Session cookie deleted in devtools, then any action → `Session ended. Please
      log in again.`

## 4. Traceability

Every section of `specs.txt` and where it is satisfied.

| `specs.txt` | Slice | Evidence |
|-------------|-------|----------|
| §1 Overview, objectives | 00, 01 | Architecture in `01` §1/§2; objectives restated in `00` §1 |
| §2 ATM UI (keypad, display, look) | 03 | `ui/keypad.ts`, `ui/display.ts`, CSS sketch in `03` §1; manual checklist §3 |
| §3 Authentication (multi-tap, A–Z, ≥3, no password) | 03, 04 | `ui/multitap.ts` tests, `sessions.ts`, `POST /api/session`, unique-name check and login-screen warning |
| §4 Shared account (one balance, AUD, persisted) | 02 | `db.ts` seed + reopen test, `money.ts`, `GET /api/account` |
| §5 Homepage (welcome, balance, 3 buttons, AI button) | 03, 04, 08 | `screens/home.ts`, `ui/assistant.ts`; live balance via 05 |
| §6 Withdraw | 06, 07 | `account.withdraw`, `routes/transactions.ts`, amount screen |
| §7 Deposit | 06, 07 | `account.deposit`, `AMOUNT_TOO_LARGE` at `$10,000.00` |
| §8 Locking (all seven bullets) | 07 | `lock.ts`, `transactions-lock.test.ts`, §3 manual rows |
| §9 Activity log | 01 (schema), 02 (writer), 04/06/07 (events), 08 (query) | `activity_log` table, `toPublicEntry`, `GET /api/activity` |
| §10 AI assistant | 08 | `retrieval.ts`, `assistant.ts`, `ollama.ts`, chat panel |
| §11 Sign out | 04 | `DELETE /api/session`, `logout` entry |
| §12 Architecture and stack | 01 | Table in `01` §1, layout in `01` §2 |
| §13 A Real-time balance | 05 | `realtime.ts` both sides, realtime tests |
| §13 B Cancellation | 06, 07 | BACK path, `DELETE /api/lock?cancelled=…` |
| §13 C Lock timeout | 07 | `LOCK_LEASE_MS`, `renew`, `sweepExpired` |
| §13 D Atomic transactions | 06 | One `db.transaction` for validate + update + log |
| §13 E Initial balance | 02 | `INITIAL_BALANCE_CENTS`, seed-once test |
| §13 F AI accuracy | 08 | Retrieval-only prompt, evidence list, read-only import test |
| §14 Final objective | 09 | Demo script §6, checklist §3 |

## 5. Concurrency proof

The distributed-systems claim rests on four tests. They must exist, and they must
fail if the mechanism is removed.

1. **Mutual exclusion.** 20 sessions acquire concurrently; exactly one wins. Remove
   the null check in `acquire` and this test fails.
2. **No lost updates.** 5 sessions each attempt two deposits after acquiring; the
   final balance equals `initial + 10,000 × successes`, and the number of `deposit`
   log rows equals `successes`. Wrap `account.deposit` without its transaction and
   this test fails.
3. **No negative balance.** Twenty `$300` withdrawals from `$1,000` leave `$100.00`
   and three successes, whatever the interleaving.
4. **Unique names.** Twenty logins with the same name at once: one 201, nineteen 409,
   one `login` row. Remove the synchronous `isNameTaken` check and this fails.

Record the actual output of these four in the project report; a screenshot of a
passing run is the evidence that the requirement is met, not the design text.

## 6. Demo script (about five minutes)

1. Start the server, read the banner, open the ATM on a laptop and a phone.
2. Log in as `ALEX` on the laptop, `BLAKE` on the phone. Point at the identical
   balance on both screens.
3. On the laptop: Withdraw → hold on the amount screen. On the phone: try Deposit →
   read the refusal out loud. Both screens still show the live balance.
4. Cancel on the laptop. Deposit `$500` on the phone. The laptop's balance updates
   with no reload.
5. On the laptop, withdraw `$200`. Show the log rows in `sqlite3`, including the
   cancelled attempt and the failed attempt from step 3 if there was one.
6. Ask the assistant "Who made the last withdrawal?" and open the evidence list.
7. Stop the server with Ctrl-C, start it again, log in, show the same balance and the
   full log.

## 7. LAN runbook

**Host computer**

```bash
node --version                 # 20 or newer
npm install
npm run build
npm start                      # prints http://<lan-ip>:3000
```

**Ollama (optional for the ATM, required for the assistant)**

```bash
ollama serve                   # or the desktop app
ollama pull llama3.2:3b
curl http://127.0.0.1:11434/api/tags   # sanity check
```

If the model name differs, set `OLLAMA_MODEL` before `npm start`.

**Reaching it from a phone**

1. Both devices on the same Wi-Fi (not guest isolation, no VPN).
2. Use the LAN URL from the banner, e.g. `http://192.168.1.24:3000`.
3. If it does not load, allow the port on the host firewall:
   - Linux (ufw): `sudo ufw allow 3000/tcp`
   - macOS: allow the prompt for `node` on first run
   - Windows: allow Node.js on private networks
4. The server binds `0.0.0.0`; if `HOST` was changed to `127.0.0.1`, phones cannot
   connect. That is the first thing to check.

**Data**

- `data/atm.db` holds the balance and the log. Back it up by copying the file.
- To start fresh for a demo: stop the server, `rm data/atm.db`, start again. The
  balance returns to `$1,000.00`. Never delete it during the demo.

## 8. Known limits (deliberate, and worth saying out loud in the report)

- **One server process.** The lock lives in that process's memory. Two servers
  pointed at the same SQLite file would each allow a transaction, because neither
  knows about the other. Closing that gap needs a database row with a lease or a
  single writer service — out of scope for one host, and the honest framing is
  "centralised coordinator, not replicated".
- **Sessions are memory-resident.** A restart logs everyone out. The balance and log
  survive, which is what §13 E requires.
- **No passwords, by design.** The name is a label for the log, not an identity.
  Anyone on the Wi-Fi can take a name that is free. That is the source spec's choice.
- **Names are unique only while in use.** A name is reserved by the live session that
  holds it and frees itself when that session ends — on sign-out, or about a minute
  after the last browser tab on it closes. Two people therefore cannot be `ALEX` at
  the same time, but the next day `ALEX` might be someone else. Uniqueness is a
  coordination rule, not a security boundary.
- **Plain HTTP.** Fine on a trusted LAN; not for anything real.
- **The AI is only as good as the retrieved rows.** If a question needs data outside
  the 50-entry window, the assistant says so rather than guessing — that is the
  §13 F requirement working as intended.
- **Whole-dollar entry.** The keypad has no decimal point, so amounts are whole
  dollars. The balance is stored in cents and can hold cents from future features.
- **SQLite over a network share is unsupported.** Keep `data/` on local disk.

## 9. Review checklist

For the person reviewing the finished code, in addition to `reviewing.md`:

- [ ] `acquire` in `lock.ts` contains no `await` and no async signature.
- [ ] The name uniqueness check and `createSession` in `POST /api/session` sit in one
      synchronous stretch, with no `await` between the check and the create.
- [ ] Every mutating handler has exactly one `db.transaction`.
- [ ] No route broadcasts before its commit.
- [ ] No client computes a balance; every balance on screen came from a response or
      an event.
- [ ] `assistant.ts`, `retrieval.ts` and `ollama.ts` import nothing that can write.
- [ ] Every `*_failed` and `transaction_cancelled` row has a `reason`.
- [ ] No `any`, no `@ts-ignore` in `src/`.
- [ ] Every log timestamp is rendered by the server, never by the browser.
- [ ] Manual checklist §3 fully ticked on two devices.
