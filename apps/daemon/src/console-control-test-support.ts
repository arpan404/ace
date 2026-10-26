import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { z } from "zod";
import {
  daemonCliSource,
  daemonEnv,
  daemonPackage,
  temporaryHome,
  type Cleanups,
} from "./daemon-launch-test-support.ts";

// Resolves koffi as a dependency of provider-kit; nothing is imported from its sources.
const providerKit = fileURLToPath(new URL("../../../packages/provider-kit/", import.meta.url));

/**
 * A helper with a console of its own starts `ace start` attached to it, then raises a real
 * console control event for everything on that console: once the daemon is ready, or as soon as
 * it holds its lock (mid-startup). The helper ignores the event; the daemon must stop in order.
 */
const helper = `
import koffi from "koffi";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const plan = JSON.parse(process.env.ACE_CONSOLE_PLAN);
const report = (value) => { writeFileSync(plan.out, JSON.stringify(value)); process.exit(0); };
const kernel = koffi.load("kernel32.dll");
const user = koffi.load("user32.dll");
const alloc = kernel.func("int __stdcall AllocConsole()");
const consoleWindow = kernel.func("void* __stdcall GetConsoleWindow()");
const show = user.func("int __stdcall ShowWindow(void* window, int command)");
const handler = kernel.func("int __stdcall SetConsoleCtrlHandler(void* routine, int add)");
const generate = kernel.func("int __stdcall GenerateConsoleCtrlEvent(uint event, uint group)");
const lastError = kernel.func("uint __stdcall GetLastError()");
if (!alloc()) report({ error: "AllocConsole failed " + lastError() });
show(consoleWindow(), 0);
// A detached start disables Ctrl+C for the new group; children inherit normal handling again.
handler(null, 0);
process.on("SIGINT", () => {});
process.on("SIGBREAK", () => {});
const daemon = spawn(process.execPath, [plan.cli, "start"], { cwd: plan.cwd, env: plan.env, stdio: ["ignore", "pipe", "pipe"] });
let output = "", errors = "", sent = false, sawReady = false;
const send = () => {
  if (sent) return;
  sent = true;
  if (!generate(plan.event === "break" ? 1 : 0, 0)) report({ error: "GenerateConsoleCtrlEvent failed " + lastError() });
};
daemon.stdout.on("data", (chunk) => {
  output += chunk;
  if (!output.includes("Token file:")) return;
  sawReady = true;
  if (plan.when === "ready") send();
});
daemon.stderr.on("data", (chunk) => { errors += chunk; });
if (plan.when === "starting") {
  const poll = setInterval(() => { if (existsSync(plan.lock)) { clearInterval(poll); send(); } }, 5);
}
daemon.on("exit", (code, signal) => report({ code, signal, sawReady, sent, pid: daemon.pid, errors: errors.slice(-2000) }));
setTimeout(() => { daemon.kill(); report({ error: "daemon did not exit", errors: errors.slice(-2000) }); }, 90000);
`;

const Outcome = z.object({
  code: z.number().nullable().optional(),
  signal: z.string().nullable().optional(),
  sawReady: z.boolean().optional(),
  sent: z.boolean().optional(),
  pid: z.number().optional(),
  errors: z.string().optional(),
  error: z.string().optional(),
});

export async function daemonInConsole(
  home: string,
  plan: { event: "c" | "break"; when: "ready" | "starting" },
  cleanups: Cleanups,
): Promise<z.infer<typeof Outcome>> {
  const directory = await temporaryHome("ace-console-", cleanups);
  const out = join(directory, "outcome.json");
  const log = join(directory, "helper.log");
  const errors = openSync(log, "w");
  const child = spawn(process.execPath, ["--input-type=module", "-e", helper], {
    cwd: providerKit,
    detached: true,
    stdio: ["ignore", errors, errors],
    env: {
      ...process.env,
      ACE_CONSOLE_PLAN: JSON.stringify({
        ...plan,
        out,
        cli: daemonCliSource,
        cwd: daemonPackage,
        env: daemonEnv(home),
        lock: join(home, "daemon-lock"),
      }),
    },
  });
  closeSync(errors);
  let helperExited = false;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => {
      helperExited = true;
      resolve();
    }),
  );
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  const outcome = () => readFile(out, "utf8").catch(() => "");
  await expect
    .poll(async () => (await outcome()) !== "" || helperExited, { timeout: 120_000 })
    .toBe(true);
  const text = await outcome();
  if (!text)
    throw new Error(`Console helper exited without an outcome:\n${await readFile(log, "utf8")}`);
  return Outcome.parse(JSON.parse(text));
}
