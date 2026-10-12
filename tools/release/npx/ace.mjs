#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// npm supplies this package's bin. All CLI and home policy runs in the bundled runtime.
const child = spawn(
  fileURLToPath(new URL("../runtime/bin/node", import.meta.url)),
  [fileURLToPath(new URL("../runtime/ace.mjs", import.meta.url)), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
child.once("error", (error) => {
  const result = {
    ok: false,
    status: "refused",
    error: `Bundled ace runtime could not start: ${error.message}`,
  };
  if (process.argv.some((argument) => argument === "--json" || argument === "--jq"))
    process.stdout.write(JSON.stringify(result) + "\n");
  else process.stderr.write(result.error + "\n");
  process.exitCode = 4;
});
child.once("close", (code, signal) => {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  if (process.exitCode === undefined) process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
});
