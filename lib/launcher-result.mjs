export function parseLauncherResult(output) {
  const line = String(output).trim().split(/\r?\n/).reverse().find((entry) => entry.trim().startsWith("{"));
  if (!line) throw new Error("Missing launcher result");
  return JSON.parse(line);
}
