import { withMaintenanceAdmission } from "../../lib/operation-lock.mjs";

const [runtimeDirectory, operationId] = process.argv.slice(2);
if (!runtimeDirectory || !operationId) throw new Error("Invalid admission fixture arguments");

let finish;
const held = new Promise((resolve) => (finish = resolve));
const keepAlive = setInterval(() => {}, 1_000);
process.on("SIGINT", finish);
process.on("SIGTERM", finish);
await withMaintenanceAdmission(runtimeDirectory, {
  ownerCommand: "server.mjs",
  operationId,
}, async () => held);
clearInterval(keepAlive);
