import { runMobileDependencyWorker } from "../lib/mobile-app-dependencies.mjs";

const value = (name) => process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1) || "";

await runMobileDependencyWorker({
  kind: value("--kind"),
  statePath: value("--state"),
  sourceDirectory: value("--source"),
  storageRoot: value("--storage"),
  projectPath: value("--project"),
  flutterBin: value("--flutter-bin") || null,
});
