#!/usr/bin/env node
import net from "node:net";

const socketPath = String(process.env.WFL_CODEX_ASKPASS_SOCKET || "");
if (!socketPath) process.exit(1);

const socket = net.createConnection(socketPath);
const timeout = setTimeout(() => socket.destroy(new Error("askpass timeout")), 5_000);
socket.pipe(process.stdout);
socket.once("close", () => {
  clearTimeout(timeout);
  process.exit(0);
});
socket.once("error", () => {
  clearTimeout(timeout);
  process.exit(1);
});
