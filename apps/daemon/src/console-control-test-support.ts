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
// Bind stderr to the test's log before the new console replaces the standard handles.
process.stderr.write("");
process.on("uncaughtException", (error) => report({ error: String(error?.stack ?? error) }));
const step = (text) => process.stderr.write(text + "\\n");
const kernel = koffi.load("kernel32.dll");
const user = koffi.load("user32.dll");
const alloc = kernel.func("int __stdcall AllocConsole()");
const free = kernel.func("int __stdcall FreeConsole()");
const consoleWindow = kernel.func("void* __stdcall GetConsoleWindow()");
const show = user.func("int __stdcall ShowWindow(void* window, int command)");
const handler = kernel.func("int __stdcall SetConsoleCtrlHandler(void* routine, int add)");
const lastError = kernel.func("uint __stdcall GetLastError()");
if (!alloc()) report({ error: "AllocConsole failed " + lastError() });
show(consoleWindow(), 0);
// A detached start disables Ctrl+C for the new group; the daemon inherits normal handling.
handler(null, 0);
const daemon = spawn(process.execPath, [plan.cli, "start"], { cwd: plan.cwd, env: plan.env, stdio: ["ignore", "pipe", "pipe"] });
// The console stays with the daemon; this helper leaves it so the event never reaches it.
free();
step("daemon spawned " + daemon.pid);
let output = "", errors = "", sent = false, sawReady = false, sender;
const send = () => {
  if (sent) return;
  sent = true;
  step("sending " + plan.event);
  // The sender joins the daemon's console, raises the event there, and may end with it.
  const raise = spawn(process.execPath, ["-e", plan.sender], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ACE_TARGET: String(daemon.pid), ACE_EVENT: plan.event === "break" ? "1" : "0" },
  });
  raise.on("exit", (code) => { sender = code; step("sender exited " + code); });
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
daemon.on("exit", (code, signal) => setTimeout(() => report({ code, signal, sawReady, sent, sender, pid: daemon.pid, errors: errors.slice(-2000) }), 500));
setTimeout(() => { daemon.kill(); report({ error: "daemon did not exit", sender, errors: errors.slice(-2000) }); }, 90000);
`;
// Attaches to the target's console, ignores Ctrl+C itself, raises the event for the console.
const sender =
  'const koffi=require("koffi");const k=koffi.load("kernel32.dll");' +
  'const attach=k.func("int __stdcall AttachConsole(uint pid)");' +
  'const ignore=k.func("int __stdcall SetConsoleCtrlHandler(void* routine,int add)");' +
  'const raise=k.func("int __stdcall GenerateConsoleCtrlEvent(uint event,uint group)");' +
  "if(!attach(Number(process.env.ACE_TARGET)))process.exit(2);ignore(null,1);" +
  "process.exit(raise(Number(process.env.ACE_EVENT),0)?0:3);";

const Outcome = z.object({
  code: z.number().nullable().optional(),
  signal: z.string().nullable().optional(),
  sawReady: z.boolean().optional(),
  sent: z.boolean().optional(),
  sender: z.number().nullable().optional(),
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
        sender,
      }),
    },
  });
  closeSync(errors);
  let helperExited: string | undefined;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", (code, signal) => {
      helperExited = `code ${code} signal ${signal}`;
      resolve();
    }),
  );
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  const outcome = () => readFile(out, "utf8").catch(() => "");
  await expect
    .poll(async () => (await outcome()) !== "" || helperExited !== undefined, { timeout: 120_000 })
    .toBe(true);
  const text = await outcome();
  if (!text)
    throw new Error(
      `Console helper exited (${helperExited}) without an outcome:\n${await readFile(log, "utf8")}`,
    );
  return Outcome.parse(JSON.parse(text));
}
