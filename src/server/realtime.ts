import type http from "node:http";
import type Database from "better-sqlite3";
import { Server } from "socket.io";
import type { Account, ActivityEntry, LockState } from "../shared/types";
import { getAccount } from "./account";
import { getSession, readSessionId, setSessionSockets } from "./sessions";

/**
 * Lock reader used for `lock:updated`. Slice 07 replaces the default with the
 * real LockManager; the broadcast loop below does not change.
 */
type LockStateFor = (sessionId: string | null) => LockState;

const NO_LOCK: LockState = { locked: false, ownerName: null, isMine: false, expiresAtMs: null };

let io: Server | null = null;
let lockStateFor: LockStateFor = () => NO_LOCK;

/** sessionId -> connected socket ids; presence drives session lifetime. */
const socketsBySession = new Map<string, Set<string>>();

export function attachRealtime(
  server: http.Server,
  deps: { db: Database.Database; lockStateFor?: LockStateFor },
): Server {
  if (deps.lockStateFor) {
    lockStateFor = deps.lockStateFor;
  }

  const serverIo = new Server(server, { cors: { origin: true } });
  io = serverIo;

  serverIo.on("connection", (socket) => {
    const sessionId = readSessionId(socket.handshake.headers.cookie);
    const session = sessionId ? getSession(sessionId) : null;
    const liveSessionId = session ? session.id : null;

    socket.data.sessionId = liveSessionId;
    socket.data.userName = session ? session.userName : null;

    if (liveSessionId) {
      const sockets = socketsBySession.get(liveSessionId) ?? new Set<string>();
      sockets.add(socket.id);
      socketsBySession.set(liveSessionId, sockets);
      setSessionSockets(liveSessionId, sockets.size);
    }

    // First paint needs no round trip.
    socket.emit("account:updated", { account: getAccount(deps.db) });
    socket.emit("lock:updated", { lock: lockStateFor(socket.data.sessionId) });

    socket.on("disconnect", () => {
      if (!liveSessionId) {
        return;
      }
      const sockets = socketsBySession.get(liveSessionId);
      if (!sockets) {
        return;
      }
      sockets.delete(socket.id);
      if (sockets.size > 0) {
        setSessionSockets(liveSessionId, sockets.size);
        return;
      }
      socketsBySession.delete(liveSessionId);
      setSessionSockets(liveSessionId, 0); // starts the grace countdown
    });
  });

  return serverIo;
}

export function broadcastAccount(account: Account): void {
  io?.emit("account:updated", { account });
}

export function broadcastActivity(entry: ActivityEntry): void {
  io?.emit("activity:created", { entry });
}

/** The only per-socket send: `isMine` depends on who is receiving. */
export function broadcastLockState(): void {
  if (!io) {
    return;
  }
  for (const socket of io.sockets.sockets.values()) {
    socket.emit("lock:updated", { lock: lockStateFor(socket.data.sessionId) });
  }
}

export function getIo(): Server | null {
  return io;
}
