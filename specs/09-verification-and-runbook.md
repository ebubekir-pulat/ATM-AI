# 09 — Verification, Runbook and Traceability

**Depends on:** all previous slices.
**Delivers:** the proof the project does what `specs.txt` asks, the steps to run it on
the Wi-Fi, a demo script, and an honest list of limits.
**Covers:** `specs.txt` §14, and every other section through the table in §4.

---

## 1. Definition of done

1. `npm install && npm run build && npm test` passes from a clean clone on the hosting
   computer.
2. `npm start` serves the ATM on `http://<lan-ip>:3000` and a phone on the same Wi-Fi can
   log in and transact.
3. Every item in §3 is observed and ticked.
4. Every suite in §2 exists and passes.
5. `specs.txt` is unmodified (`git diff --stat specs/specs.txt` is empty).
6. A reviewer can read `specs/00`–`09` beside the code without asking how a requirement
   maps to a file; §4 is the index.

## 2. Automated suites

| Suite | Guards |
|-------|--------|
| Unit (money, time, multi-tap, router) | format and input rules |
| Account and transactions | validation, atomicity, log rows |
| Lock concurrency | one lock at a time under 20 parallel acquires |
| Lock lifecycle | release on success, failure, cancel, sign-out, disconnect, expiry |
| Realtime | broadcast payloads, per-socket `isMine`, reconnect re-sync |
| Retrieval and assistant | prompt contents, no-fabrication fallback, read-only modules |
| API shape | every error is `{ error: { code, message } }` |
| Type check | `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.client.json --noEmit` |

All run under `npm test` except the type check. `npm test` must exit on its own: every
test closes its sockets, server and in-memory database. A hanging run is a defect.

## 3. Manual multi-client checklist

Two devices (laptop plus phone) on the same Wi-Fi. Each slice's acceptance criteria are
ticked on its own; this list only adds what needs more than one client or a reboot.

**Shared account and names (§4, §5)**
- [ ] A and B log in with different names; both homepages show the same balance.
- [ ] C tries A's name while A is logged in: the warning appears while typing and ENTER
      is refused. After A signs out, C (or A) can log in with that name, and the log
      shows it as the same name throughout.
- [ ] A deposits `$100`; B's balance rises without a reload, and a reload mid-transaction
      still shows the shared balance.

**Locking (§8)**
- [ ] A sits on the amount screen while B presses Deposit and reads `Another transaction
      is in progress (A). Try again in a moment.` B still sees the live balance.
- [ ] A presses BACK; B transacts immediately. A closes the tab instead; B transacts
      within a few seconds.
- [ ] With A's cookie, a direct `POST /api/transactions/withdraw` while B holds the lock
      returns `409 LOCK_NOT_HELD` and the balance is unchanged.

**Transactions (§6, §7)** — covered by `06` §7; on two devices, confirm B's balance
follows every deposit, withdrawal, failure and cancel.

**Log (§9)**
- [ ] `sqlite3 data/atm.db "select local_date, local_time, user_name, event_type, amount_cents from activity_log order by id"`
      shows every login, logout, deposit, withdrawal, failed attempt and cancel, in
      order, with times matching the host's clock and timezone.
- [ ] Restarting the server leaves the log intact.

**AI (§10)** — covered in full by `08` §9; additionally check that two users get the same
answer to the same question and that `Based on N log entries` matches it.

**Sign out (§11)**
- [ ] Sign out → login screen, a `logout` entry, the other browser unaffected.
- [ ] Delete the session cookie in devtools, then any action → `Session ended. Please log
      in again.`

## 4. Traceability

| `specs.txt` | Slice | Evidence |
|-------------|-------|----------|
| §1 Overview, objectives | 00, 01 | Architecture `01` §1/§2; objectives in `00` |
| §2 ATM UI | 03 | `ui/keypad.ts`, `ui/display.ts`, sketch `03` §1, checklist §3 |
| §3 Authentication | 03, 04 | `ui/multitap.ts`, `sessions.ts`, `names.ts`, `POST /api/session` (live-holder check), login-screen warning |
| §4 Shared account | 02 | `db.ts` seed + reopen test, `money.ts`, `GET /api/account` |
| §5 Homepage | 03, 04, 08 | `screens/home.ts`, `ui/assistant.ts`; live balance via 05 |
| §6 Withdraw | 06, 07 | `account.withdraw`, `routes/transactions.ts`, amount screen |
| §7 Deposit | 06, 07 | `account.deposit`, `AMOUNT_TOO_LARGE` at `$10,000.00` |
| §8 Locking (all seven bullets) | 07 | `lock.ts`, `transactions-lock.test.ts`, checklist §3 |
| §9 Activity log | 01 (schema), 02 (writer), 04/06/07 (events), 08 (query) | `activity_log`, `toPublicEntry`, `GET /api/activity` |
| §10 AI assistant | 08 | `retrieval.ts`, `assistant.ts`, `ollama.ts`, chat panel |
| §11 Sign out | 04 | `DELETE /api/session`, `logout` entry |
| §12 Architecture and stack | 01 | `01` §1, §2 |
| §13 A Real-time balance | 05 | `realtime.ts` both sides, realtime tests |
| §13 B Cancellation | 06, 07 | BACK path, `DELETE /api/lock?cancelled=…` |
| §13 C Lock timeout | 07 | `LOCK_LEASE_MS`, `renew`, `sweepExpired` |
| §13 D Atomic transactions | 06 | One `db.transaction` for validate + update + log |
| §13 E Initial balance | 02 | `INITIAL_BALANCE_CENTS`, seed-once test |
| §13 F AI accuracy | 08 | Retrieval-only prompt, evidence list, read-only import test |
| §14 Final objective | 09 | Demo script §6, checklist §3 |

## 5. Concurrency proof

The distributed-systems claim rests on four tests. They must exist and must fail if the
mechanism is removed.

1. **Mutual exclusion.** 20 sessions acquire concurrently; exactly one wins. Remove the
   null check in `acquire` and this fails.
2. **No lost updates.** 5 sessions each attempt two deposits after acquiring; final
   balance is `initial + 10,000 × successes` and the number of `deposit` rows equals
   `successes`. Wrap `account.deposit` without its transaction and this fails.
3. **No negative balance.** Twenty `$300` withdrawals from `$1,000` leave `$100.00` and
   three successes, whatever the interleaving.
4. **Unique names.** Twenty logins with the same name at once: one 201, nineteen 409, one
   `login` row and one `user_names` row. Drop the live-holder check in `POST /api/session`
   and this fails.

Record the actual output of these four in the report; a screenshot of a passing run is
the evidence, not the design text.

## 6. Demo script (about five minutes)

1. Start the server, read the banner, open the ATM on a laptop and a phone.
2. Log in as `ALEX` on the laptop, `BLAKE` on the phone; point at the identical balance.
3. Laptop: Withdraw → stay on the amount screen. Phone: try Deposit → read the refusal
   out loud. Both screens still show the live balance.
4. Cancel on the laptop. Deposit `$500` on the phone; the laptop updates with no reload.
5. Withdraw `$200` on the laptop. Show the log rows in `sqlite3`, including the cancelled
   attempt.
6. Ask the assistant "Who made the last withdrawal?" and open the evidence list.
7. Ctrl-C, start again, log in as `ALEX` again — the balance and the full log are intact
   and the log still says `ALEX`.

## 7. LAN runbook

**Host**

```bash
node --version                 # 20 or newer
npm install
npm run build
npm start                      # prints http://<lan-ip>:3000
```

**Ollama** (optional for the ATM, required for the assistant)

```bash
ollama serve
ollama pull llama3.2:3b
curl http://127.0.0.1:11434/api/tags   # sanity check
```

Set `OLLAMA_MODEL` before `npm start` if the pulled model has another name.

**From a phone**

1. Both devices on the same Wi-Fi — no guest isolation, no VPN.
2. Use the LAN URL from the banner, e.g. `http://192.168.1.24:3000`.
3. If it does not load, allow the port: Linux `sudo ufw allow 3000/tcp`; macOS allow the
   prompt for `node`; Windows allow Node.js on private networks.
4. The server binds `0.0.0.0`. If `HOST` was changed to `127.0.0.1`, phones cannot
   connect — check that first.

**Data.** `data/atm.db` holds balance, log and names; back it up by copying the file. To
start fresh: stop the server, `rm data/atm.db`, start again → `$1,000.00`, an empty log
and an empty name registry. Never delete it during the demo.

## 8. Known limits (deliberate, worth saying in the report)

- **One server process.** The lock is in that process's memory. Two servers on the same
  SQLite file would each allow a transaction. Closing that gap needs a database lease or
  a single-writer service — out of scope, so the honest framing is "centralised
  coordinator, not replicated".
- **Sessions are memory-resident.** A restart logs everyone out; balance, log and names
  survive.
- **No passwords, by design.** The name is a label for the log, not an identity check:
  anyone on the Wi-Fi can log in with any name that is not in use right now.
- **Uniqueness is about the record and the moment.** `user_names` holds one row per name
  and the log's `user_name` refers to it, so `SIMON` on Monday and `SIMON` on Tuesday are
  the same actor in the log. But the server cannot verify the human behind the name: the
  same person returning is `SIMON`, and so is anyone else who types it. Two sessions
  cannot hold a name at once, which is a coordination rule, not a security boundary.
- **Plain HTTP.** Fine on a trusted LAN; not for anything real.
- **The AI is only as good as the retrieved rows.** A question needing data outside the
  50-entry window gets an honest "not enough information", which is §13 F working.
- **Whole-dollar entry.** No decimal point on the keypad; cents are stored and formatted
  for future features.
- **SQLite over a network share is unsupported.** Keep `data/` on local disk.

## 9. Review checklist

For the person reviewing the finished code, in addition to `reviewing.md`:

- [ ] `acquire` in `lock.ts` has no `await` and no async signature.
- [ ] The name rule is two checks only: `ensureName` (one row per name) and
      `findSessionByName` (no two live sessions share one), with no `await` between the
      second check and `createSession`.
- [ ] Every mutating handler has exactly one `db.transaction`.
- [ ] No route broadcasts before its commit.
- [ ] No client computes a balance; every balance came from a response or an event.
- [ ] `assistant.ts`, `retrieval.ts` and `ollama.ts` import nothing that can write.
- [ ] Every `*_failed` and `transaction_cancelled` row has a `reason`.
- [ ] No `any`, no `@ts-ignore` in `src/`.
- [ ] Every log timestamp is rendered by the server, never by the browser.
- [ ] Manual checklist §3 fully ticked on two devices.
