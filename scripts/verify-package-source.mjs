import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPackageSource } from "../lib/package-source.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const expectedCommit = optionValue("--expect-commit");
const source = await inspectPackageSource(projectDir, { expectedCommit });
console.log(`Verified release package v${source.version} from ${source.manifest.sourceCommit}`);

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
