import { RestoreSwapJournal } from "../../lib/restore-swap-journal.mjs";

const runtimeDirectory = process.env.RESTORE_TEST_RUNTIME_DIR;
const action = process.env.RESTORE_TEST_ACTION;
const journal = new RestoreSwapJournal(runtimeDirectory, {
  afterRename: async ({ action: completedAction }) => {
    if (completedAction === action) process.kill(process.pid, "SIGKILL");
  },
});

await journal.read();
if (action === "move-old") await journal.moveOriginalAside(0);
else if (action === "activate-new") await journal.activateReplacement(0);
else throw new Error("Invalid restore crash action");
