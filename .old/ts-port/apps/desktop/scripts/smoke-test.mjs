import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const electronBin = resolve(desktopDir, "node_modules/.bin/electron");
const mainJs = resolve(desktopDir, "dist-electron/main.js");

console.log("\nLaunching Electron smoke test...");

const childEnv = {
  ...process.env,
  ACE_HOME: mkdtempSync(resolve(tmpdir(), "ace-smoke-data-")),
  ACE_LOCAL_DESKTOP_RUN: "1",
  ELECTRON_ENABLE_LOGGING: "1",
  HOME: mkdtempSync(resolve(tmpdir(), "ace-smoke-home-")),
};
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.VITE_DEV_SERVER_URL;

let timedOut = false;
const child = spawn(electronBin, [mainJs], {
  stdio: ["pipe", "pipe", "pipe"],
  env: childEnv,
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const timeout = setTimeout(() => {
  timedOut = true;
  child.kill();
}, 8_000);

child.on("exit", (code, signal) => {
  clearTimeout(timeout);

  const fatalPatterns = [
    "Cannot find module",
    "ConfigError:",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "TypeError:",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
  ];
  const failures = fatalPatterns.filter((pattern) => output.includes(pattern));
  if (!timedOut && code !== 0) {
    failures.push(`unexpected exit code ${String(code)} signal ${String(signal)}`);
  }

  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    console.error("\nFull output:\n" + output);
    process.exit(1);
  }

  console.log("Desktop smoke test passed.");
  process.exit(0);
});
