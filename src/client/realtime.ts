import type { ManagerOptions, Socket, SocketOptions } from "socket.io-client";
import type { Account, ActivityEntry, LockState } from "../shared/types.js";
import type { Connection } from "./state.js";
import { getAccount } from "./api.js";

// /socket.io/socket.io.js (loaded by index.html) defines the global.
declare const io: {
  (uri?: string, opts?: Partial<ManagerOptions & SocketOptions>): Socket;
  (opts?: Partial<ManagerOptions & SocketOptions>): Socket;
};

export interface RealtimeHandlers {
  onAccount: (account: Account) => void;
  onLock: (lock: LockState) => void;
  onActivity: (entry: ActivityEntry) => void;
  onStatus: (status: Connection) => void;
}

let socket: Socket | null = null;

/** Thin adapter: parses nothing, keeps no state. */
export function connectRealtime(handlers: RealtimeHandlers): void {
  const current = io({ reconnectionDelayMax: 3000 });
  socket = current;

  current.on("connect", () => {
    handlers.onStatus("connected");
    // The cookie is read during the handshake only, so a reconnect repairs
    // anything missed (including a login in this tab) with one re-fetch.
    void getAccount()
      .then(handlers.onAccount)
      .catch(() => {
        // Not logged in, or the server blipped; the next event repairs it.
      });
  });

  current.on("disconnect", () => handlers.onStatus("connecting"));
  current.on("connect_error", () => handlers.onStatus("offline"));
  current.on("reconnect_failed", () => handlers.onStatus("offline"));

  current.on("account:updated", (payload: { account: Account }) => handlers.onAccount(payload.account));
  current.on("lock:updated", (payload: { lock: LockState }) => handlers.onLock(payload.lock));
  current.on("activity:created", (payload: { entry: ActivityEntry }) => handlers.onActivity(payload.entry));
}

/** Drop and re-open the socket so the handshake picks up the new cookie. */
export function refreshSession(): void {
  socket?.disconnect();
  socket?.connect();
}
