import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { checked } from "./process.ts";
import { assertLoadedTask, taskActive } from "./service-identity.ts";
import type { WindowsSpadePlan } from "./spade-plan.ts";
import {
  assertSpadeRegistration,
  incompatibleSpadeService,
  readOwnFile,
  type SpadeServicePorts,
  type SpadeServiceState,
} from "./spade-registration.ts";

/**
 * Spade's Windows service: a per-user Task Scheduler task running `bin\spade.cmd`, managed
 * with `schtasks.exe` and checked against ace's record of it, like the daemon's task.
 */

async function registered(plan: WindowsSpadePlan, ports: SpadeServicePorts): Promise<boolean> {
  const query = await ports.run("schtasks.exe", ["/Query", "/TN", plan.name, "/XML"]);
  if (query.code === 0) {
    try {
      assertLoadedTask(plan, query.stdout);
    } catch (cause) {
      throw incompatibleSpadeService(plan.name, cause);
    }
    if (readOwnFile(plan.file) === undefined) throw incompatibleSpadeService(plan.file);
    return true;
  }
  // schtasks reports a missing task only in localized words, so look for it in the list.
  const list = await ports.run("schtasks.exe", ["/Query", "/FO", "CSV", "/NH"]);
  if (list.code !== 0) throw new Error(`Cannot query Spade's task: ${list.stderr}`);
  const name = `"${plan.name.toLowerCase()}"`;
  if (list.stdout.split(/\r?\n/).some((line) => line.toLowerCase().startsWith(name)))
    throw new Error(`Cannot query Spade's task: ${query.stderr}`);
  return false;
}

async function running(plan: WindowsSpadePlan, ports: SpadeServicePorts): Promise<boolean> {
  const status = await checked(ports.run, "schtasks.exe", [
    "/Query",
    "/TN",
    plan.name,
    "/V",
    "/FO",
    "CSV",
    "/NH",
  ]);
  return taskActive(plan, status.stdout);
}

export async function spadeTaskState(
  plan: WindowsSpadePlan,
  ports: SpadeServicePorts,
): Promise<SpadeServiceState> {
  assertSpadeRegistration(plan);
  if (!(await registered(plan, ports))) return "absent";
  return (await running(plan, ports)) ? "running" : "stopped";
}

async function replaceFile(path: string, content: string | Buffer): Promise<void> {
  await mkdir(win32.dirname(path), { recursive: true });
  await writeFile(path + ".tmp", content);
  await rename(path + ".tmp", path);
}

export async function installSpadeTask(
  plan: WindowsSpadePlan,
  ports: SpadeServicePorts,
  before: SpadeServiceState,
): Promise<SpadeServiceState> {
  const changed =
    before === "absent" ||
    readOwnFile(plan.file) !== plan.content ||
    readOwnFile(plan.launcher.file) !== plan.launcher.content;
  if (changed) {
    if (before === "running") await stop(plan, ports);
    await replaceFile(plan.launcher.file, plan.launcher.content);
    // The record goes first: a task without one is never adopted.
    await replaceFile(plan.file, plan.content);
    const xml = plan.file + ".import";
    // schtasks reads task XML as UTF-16.
    await writeFile(
      xml,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(plan.content, "utf16le")]),
    );
    try {
      await checked(ports.run, "schtasks.exe", ["/Create", "/TN", plan.name, "/XML", xml, "/F"]);
    } finally {
      await rm(xml, { force: true });
    }
  }
  if (!(await running(plan, ports))) await start(plan, ports);
  return spadeTaskState(plan, ports);
}

export async function removeSpadeTask(
  plan: WindowsSpadePlan,
  ports: SpadeServicePorts,
  before: SpadeServiceState,
): Promise<SpadeServiceState> {
  if (before === "running") await stop(plan, ports);
  if (before !== "absent")
    await checked(ports.run, "schtasks.exe", ["/Delete", "/TN", plan.name, "/F"]);
  await rm(plan.file, { force: true });
  await rm(plan.launcher.file, { force: true });
  return "absent";
}

export async function restartSpadeTask(
  plan: WindowsSpadePlan,
  ports: SpadeServicePorts,
): Promise<void> {
  if (await running(plan, ports)) await stop(plan, ports);
  await start(plan, ports);
}

async function start(plan: WindowsSpadePlan, ports: SpadeServicePorts): Promise<void> {
  await checked(ports.run, "schtasks.exe", ["/Run", "/TN", plan.name]);
  for (let waited = 0; waited < 10_000; waited += 250) {
    if (await running(plan, ports)) return;
    await ports.wait(250);
  }
}

/**
 * `schtasks /End` ends only the task's first process (conhost), so every `spade-server.exe`
 * run from this home's `releases\spade` is ended too, and only those. Spade's turns were
 * already recorded paused by the maintenance request before an update restarts it.
 */
async function stop(plan: WindowsSpadePlan, ports: SpadeServicePorts): Promise<void> {
  await ports.run("schtasks.exe", ["/End", "/TN", plan.name]);
  const releases = win32.join(plan.home, "releases", "spade") + "\\";
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$root = '${releases.replaceAll("'", "''")}'
Get-CimInstance Win32_Process -Filter "Name='spade-server.exe'" | Where-Object { ([string]$_.ExecutablePath).StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }`;
  const found = await ports.run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
  for (const pid of found.stdout.split(/\s+/).filter((line) => /^\d+$/.test(line)))
    await ports.run("taskkill.exe", ["/F", "/PID", pid]);
  for (let waited = 0; waited < 10_000; waited += 250) {
    if (!(await running(plan, ports))) return;
    await ports.wait(250);
  }
  throw new Error("Spade's task did not stop");
}
