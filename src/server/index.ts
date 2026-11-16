import http from "node:http";
import { openDatabase } from "./db";
import { createApp } from "./app";
import { DB_PATH, HOST, LAN_URLS, PORT } from "./config";

const db = openDatabase(DB_PATH);
const app = createApp({ db });
const server = http.createServer(app);

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
