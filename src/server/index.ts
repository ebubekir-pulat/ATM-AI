import http from "node:http";
import { openDatabase } from "./db";
import { createApp } from "./app";
import { sweepSessions } from "./sessions";
import { DB_PATH, HOST, LAN_URLS, PORT } from "./config";

const db = openDatabase(DB_PATH);

// Slice 05 replaces this with the real WebSocket broadcast.
function broadcastActivity(): void {}

const app = createApp({ db, broadcastActivity });
const server = http.createServer(app);

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
