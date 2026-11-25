import http from "node:http";
import { openDatabase } from "./db";
import { createApp } from "./app";
import { sweepSessions } from "./sessions";
import { attachRealtime } from "./realtime";
import { DB_PATH, HOST, LAN_URLS, PORT } from "./config";

const db = openDatabase(DB_PATH);
const app = createApp({ db });
const server = http.createServer(app);
const io = attachRealtime(server, { db });

// Sweep sessions every 5 seconds
setInterval(() => {
  sweepSessions();
}, 5000);

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other process or set PORT.`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`ATM running on http://localhost:${PORT}`);
  for (const address of LAN_URLS) {
    console.log(`  http://${address}:${PORT}`);
  }
});

// Ctrl-C stops the LAN demo all the time: close sockets, then the HTTP server
// (io.close() does both), then the database.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down.`);
  io.close(() => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
