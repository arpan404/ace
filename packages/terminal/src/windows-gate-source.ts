/**
 * Embedded ConPTY startup gate source. Imported as code (not an asset file)
 * so it travels with the esbuild daemon bundle and works from any checkout:
 * `defaultPrepareGate` materializes it as `gate.mjs` next to its config.
 *
 * Editing rules — the value must stay directly executable Node ESM:
 * no backticks, no `${`, and every backslash doubled (the `\n` below reads
 * as backslash-n in the gate). `win32.test.ts` parses the materialized file
 * with `node --check`; the Windows VM fixtures execute it for real.
 */
export const WINDOWS_GATE_SOURCE: string = `import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const configPath = process.argv[2] ?? "";
const releasePath = process.argv[3] ?? "";

function fail(message) {
  try {
    process.stderr.write("ace-windows-gate: " + message + "\\n");
  } catch {
    // stderr may be gone during teardown; the exit code still signals failure.
  }
  process.exit(1);
}

if (configPath === "" || releasePath === "") fail("missing gate arguments");

let config = null;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
  fail("unreadable gate config");
}
if (
  config === null ||
  typeof config !== "object" ||
  Array.isArray(config) ||
  typeof config.shell !== "string" ||
  config.shell === "" ||
  !Array.isArray(config.args) ||
  config.args.some((entry) => typeof entry !== "string") ||
  typeof config.cwd !== "string" ||
  config.cwd === "" ||
  config.env === null ||
  typeof config.env !== "object" ||
  Array.isArray(config.env)
) {
  fail("invalid gate config");
}

const started = Date.now();
while (!existsSync(releasePath)) {
  if (Date.now() - started > 10_000) fail("parent release timed out");
  await new Promise((resolve) => setTimeout(resolve, 5));
}

// Defense in depth: the child receives its environment explicitly below, so
// bootstrap preload vectors cannot leak across even if sanitization missed.
for (const key of Object.keys(process.env)) {
  if (key.toLowerCase() === "node_options") delete process.env[key];
}

let child;
try {
  child = spawn(config.shell, config.args, {
    cwd: config.cwd,
    env: config.env,
    stdio: "inherit",
  });
} catch {
  fail("cannot start shell");
}
let settled = false;
const done = (code) => {
  if (!settled) {
    settled = true;
    process.exit(code);
  }
};
child.on("error", () => done(127));
child.on("exit", (code, signal) => done(signal ? 1 : (code ?? 1)));
`;
