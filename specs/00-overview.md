# 00 — Overview and Build Order

**Source of truth:** `specs/specs.txt` (unchanged). These documents split it into
buildable slices; where a slice had to make a decision the source did not, the
decision is written down with its reason.

**What this project is:** a web ATM hosted on one computer, reachable by several
phones and laptops on the same Wi-Fi. Every client shares one account balance.
Only one client may deposit or withdraw at a time. Every event lands in a
persistent log, and a local LLM answers questions about that log — read-only.

**Why it is built this way:** the point of the project is to show a central
server enforcing shared state and mutual exclusion between clients that cannot
see each other. That is why commands go over HTTP (a single place to validate and
lock), events come back over WebSocket (every client sees the same truth), and
the AI is given retrieved log rows rather than database access (it cannot invent
or change anything).

---

## 1. How to use these documents

- Read `01-contracts.md` first. It fixes every name, path, type, endpoint and
  event the other slices use. Nothing else may invent a name that is not there.
- Then build slices `02` → `09` **in order**. Each slice leaves the application
  running and demoable on its own; the acceptance criteria at the end of each
  slice are the definition of done.
- A slice may add detail, but may not contradict `01`. If a slice needs a new
  endpoint, field, event or table column, add it to `01` in the same change.
- These are specifications, not task lists. Implementation plans (task by task,
  test first) are written from them afterwards.

## 2. Slices

| # | Spec | Builds | Demo at the end of the slice |
|---|------|--------|------------------------------|
| 01 | `01-contracts.md` | Repo layout, config, data model, HTTP/WS contract | (contract only) |
| 02 | `02-foundation-and-account.md` | Node/Express/TypeScript app, SQLite, account with $1,000.00, logger | `GET /api/account` returns the balance; restart keeps it |
| 03 | `03-atm-shell-and-keypad.md` | ATM frame, display, keypad, multi-tap input, screen router | The ATM runs in a browser; keypad types names and numbers |
| 04 | `04-login-sessions-home.md` | Login screen, sessions, homepage, sign out, login/logout log entries | Two browsers log in, each sees the balance, sign out is logged |
| 05 | `05-realtime-balance.md` | Socket.IO broadcasts | A balance change appears in a second browser with no refresh |
| 06 | `06-deposit-and-withdraw.md` | Amount screens, transaction endpoints, atomic updates | A deposit and a withdrawal update the balance and the log |
| 07 | `07-transaction-locking.md` | Central lock manager with lease, cancel, disconnect cleanup | A second client is refused while the first holds the lock |
| 08 | `08-activity-log-and-ai.md` | Log queries and the AI assistant | "Who made the last withdrawal?" is answered from the log |
| 09 | `09-verification-and-runbook.md` | End-to-end acceptance, race tests, LAN runbook | Full demo from two devices on the Wi-Fi |

Each slice states which sections of `specs.txt` it satisfies. Slice `09` contains
the full traceability table.

## 3. Global constraints

Copied from the source spec and from `AGENTS.md`. They apply to every slice.

- **Money is AUD.** Formatting is always `$1,234.56` (`formatAUD`), never a
  floating-point number on the wire. Balance and amounts are integer **cents**.
- **Timestamps are the server's local timezone.** Every log entry stores the
  server-local date and time as a string, rendered by the server. Clients never
  reformat a timestamp, so a phone in another timezone still shows the server's time.
- **Locking is enforced on the server.** Client-side disabling is a courtesy,
  never the mechanism.
- **Balance and logs persist** across server and browser restarts.
  `data/atm.db` is the only source of truth.
- **Open source only**; no paid services, no cloud calls. The LLM runs locally
  through Ollama.
- **Simple code.** Small modules with one job, plain HTML/CSS/TypeScript, no
  frontend framework. The complexity of the code should match the complexity of
  the problem.
- **One shared account.** There is no per-user balance anywhere in the system.
- **Uppercase A–Z only** for names; names are at least 3 characters.
- **Login names are unique in the database.** A second person who picks the same name
  is stopped on the login page, and the server is what stops them. Once a user
  logs in with a certain name, no user can use that name as long as its in the database.

## 4. Terms

| Term | Meaning |
|------|---------|
| **Session** | One logged-in browser. Identified by an httpOnly cookie `atm_sid`. |
| **Name** | The uppercase A–Z label a person logs in with. Unique in the database. |
| **Client** | A browser tab running the ATM. |
| **Lock** | The single transaction lock. Owned by at most one session at a time. |
| **Lease** | The expiry time of the lock; the owner renews it while on an amount screen. |
| **Entry** | One row of `activity_log`. |
| **Command** | A state-changing request over HTTP (`POST`/`DELETE`). |
| **Event** | A server → client WebSocket message describing new state. |

## 5. What this project is not

Non-goals, so nobody builds them:

- No passwords, accounts, cards, PINs or per-user balances.
- No interest, fees, transfers between users, or transaction history UI for the
  balance itself beyond the AI assistant.
- No internet exposure, TLS, or multi-server clustering. One process, one SQLite
  file, one LAN.
- No AI write access. The assistant never deposits, withdraws, or edits the log.
- No persistence of sessions across a server restart: everyone logs in again.
  The balance and the log survive.
