// Windows only: a link to Node named `gh` runs fake-gh.mjs with gh's own arguments.
// Node takes gh's first argument as its script, so it comes back from the resolved path.
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.FORGE_FIXTURE && /^gh(\.exe)?$/i.test(basename(process.execPath))) {
  const script = fileURLToPath(new URL("./fake-gh.mjs", import.meta.url));
  process.argv.splice(1, 1, script, basename(process.argv[1] ?? ""));
  await import("./fake-gh.mjs");
  // Node would next run gh's first argument as its own script.
  process.exit(process.exitCode ?? 0);
}
