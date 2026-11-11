import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { checked, type Runner } from "./process.ts";
import { managerFailure, noUserManager, systemctl } from "./service.ts";
import { loadedIdentity, loadedProperties } from "./service-identity.ts";
import type { DarwinSpadePlan, LinuxSpadePlan, SpadeServicePlan } from "./spade-plan.ts";
import { installedSpadeVersion } from "./spade-release.ts";
import {
  assertSpadeRegistration,
  incompatibleSpadeService,
  readOwnFile,
  systemSpadePorts,
  type SpadeServicePorts,
  type SpadeServiceState,
} from "./spade-registration.ts";

export type { SpadeServicePorts, SpadeServiceState } from "./spade-registration.ts";
import {
  installSpadeTask,
  removeSpadeTask,
  restartSpadeTask,
  spadeTaskState,
  stopSpadeTask,
} from "./spade-task.ts";

async function replaceFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + ".tmp", content, { mode: 0o600 });
  await rename(path + ".tmp", path);
}

/** Keeps `spade.log` within the daemon log's 8 MiB, as one previous generation. */
export async function rotateSpadeLog(file: string, cap = 8 * 1024 * 1024): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const size = await stat(file).then(
    (info) => info.size,
    () => 0,
  );
  if (size <= cap) return;
  await rm(file + ".previous", { force: true });
  await rename(file, file + ".previous");
}

async function launchdState(plan: DarwinSpadePlan, run: Runner): Promise<SpadeServiceState> {
  const registered = assertSpadeRegistration(plan);
  const result = await run("launchctl", ["print", plan.domain]);
  if (result.code === 113) return registered === undefined ? "absent" : "stopped";
  if (result.code !== 0) throw new Error(`Cannot query Spade's service: ${result.stderr}`);
  try {
    loadedIdentity("darwin", plan.file, plan.command, result.stdout);
  } catch (cause) {
    throw incompatibleSpadeService(plan.file, cause);
  }
  if (registered === undefined) throw incompatibleSpadeService(plan.file);
  return /^\tstate = running$/m.test(result.stdout) ? "running" : "stopped";
}

async function systemdState(plan: LinuxSpadePlan, run: Runner): Promise<SpadeServiceState> {
  const registered = assertSpadeRegistration(plan);
  const result = await systemctl(run, ["show", plan.unit, `--property=${loadedProperties}`]);
  if (result.code !== 0) {
    if (noUserManager.test(result.stderr)) throw managerFailure(result.code, result.stderr);
    throw new Error(`Cannot query Spade's service: ${result.stderr}`);
  }
  let active: boolean;
  try {
    active = loadedIdentity("linux", plan.file, plan.command, result.stdout);
  } catch (cause) {
    throw incompatibleSpadeService(plan.file, cause);
  }
  const loaded = /(?:^|\n)LoadState=loaded(?:\n|$)/.test(result.stdout);
  if (loaded && registered === undefined) throw incompatibleSpadeService(plan.file);
  if (!loaded) return registered === undefined ? "absent" : "stopped";
  return active ? "running" : "stopped";
}

/** `absent`, `stopped` or `running`; a registration ace didn't write is refused. */
export async function spadeServiceState(
  plan: SpadeServicePlan,
  ports: SpadeServicePorts = systemSpadePorts,
): Promise<SpadeServiceState> {
  if (plan.platform === "darwin") return launchdState(plan, ports.run);
  if (plan.platform === "linux") return systemdState(plan, ports.run);
  return spadeTaskState(plan, ports);
}

/**
 * Registers and starts Spade's service. Spade's binary must be installed first
 * (`installSpadeBinary`). An unchanged registration that already runs is left running.
 */
export async function installSpadeService(
  plan: SpadeServicePlan,
  ports: SpadeServicePorts = systemSpadePorts,
): Promise<SpadeServiceState> {
  const before = await spadeServiceState(plan, ports);
  if ((await installedSpadeVersion(plan.home)) === undefined)
    throw new Error("Install Spade's binary before registering its service");
  // Windows' launcher rotates the log itself, when nothing holds it open.
  if (plan.platform === "win32") return installSpadeTask(plan, ports, before);
  await rotateSpadeLog(plan.logFile);
  const changed = readOwnFile(plan.file) !== plan.content;
  if (plan.platform === "darwin") {
    if (changed && before !== "absent") await removeLoaded(plan, ports.run);
    if (changed) await replaceFile(plan.file, plan.content);
    if (changed || (await spadeServiceState(plan, ports)) === "absent")
      await checked(ports.run, "launchctl", [
        "bootstrap",
        plan.domain.slice(0, plan.domain.lastIndexOf("/")),
        plan.file,
      ]);
  } else {
    if (changed) {
      await replaceFile(plan.file, plan.content);
      await systemd(ports.run, ["daemon-reload"]);
    }
    await systemd(ports.run, ["enable", plan.unit]);
    await systemd(ports.run, [changed ? "restart" : "start", plan.unit]);
  }
  return spadeServiceState(plan, ports);
}

/** Stops Spade and removes its registration; a second removal is a no-op. */
export async function removeSpadeService(
  plan: SpadeServicePlan,
  ports: SpadeServicePorts = systemSpadePorts,
): Promise<SpadeServiceState> {
  const before = await spadeServiceState(plan, ports);
  if (plan.platform === "win32") return removeSpadeTask(plan, ports, before);
  if (plan.platform === "darwin") {
    if (before !== "absent") await removeLoaded(plan, ports.run);
    await rm(plan.file, { force: true });
    return "absent";
  }
  if (before !== "absent") {
    await systemd(ports.run, ["stop", plan.unit]);
    await systemd(ports.run, ["disable", plan.unit]);
  }
  await rm(plan.file, { force: true });
  if (before !== "absent") await systemd(ports.run, ["daemon-reload"]);
  return "absent";
}

/**
 * Restarts Spade's program on the installed `current` binary: SIGTERM, then a fresh start.
 * Refuses when the service is absent: the updater never registers Spade by itself.
 */
export async function restartSpadeService(
  plan: SpadeServicePlan,
  ports: SpadeServicePorts = systemSpadePorts,
): Promise<void> {
  const state = await spadeServiceState(plan, ports);
  if (state === "absent") throw new Error("Spade's service is not registered");
  // Windows' launcher rotates the log itself before it starts Spade: while Spade runs, its
  // `>>` redirection holds the file open and the rename would fail.
  if (plan.platform === "win32") return restartSpadeTask(plan, ports);
  await rotateSpadeLog(plan.logFile);
  if (plan.platform === "darwin") {
    // A registration launchd doesn't hold (logged out since, or booted out) is loaded instead.
    const kicked = await ports.run("launchctl", ["kickstart", "-k", plan.domain]);
    if (kicked.code === 113)
      await checked(ports.run, "launchctl", [
        "bootstrap",
        plan.domain.slice(0, plan.domain.lastIndexOf("/")),
        plan.file,
      ]);
    else if (kicked.code !== 0)
      throw new Error(`launchctl failed (${kicked.code}): ${kicked.stderr}`);
    return;
  }
  await systemd(ports.run, ["restart", plan.unit]);
}

/**
 * Stops Spade's program and keeps its registration, for a rollback that must replace the
 * database while nothing has it open. launchd's KeepAlive would start a killed job again, so
 * the job is booted out; `restartSpadeService` loads it again.
 */
export async function stopSpadeService(
  plan: SpadeServicePlan,
  ports: SpadeServicePorts = systemSpadePorts,
): Promise<void> {
  const state = await spadeServiceState(plan, ports);
  if (state === "absent") throw new Error("Spade's service is not registered");
  if (plan.platform === "win32") return stopSpadeTask(plan, ports);
  if (plan.platform === "darwin") return removeLoaded(plan, ports.run);
  await systemd(ports.run, ["stop", plan.unit]);
}

async function removeLoaded(plan: DarwinSpadePlan, run: Runner): Promise<void> {
  const result = await run("launchctl", ["bootout", plan.domain]);
  // 113: already gone, 3: no such process (launchd's answer while it tears the job down).
  if (result.code !== 0 && result.code !== 113 && result.code !== 3)
    throw new Error(`launchctl failed (${result.code}): ${result.stderr}`);
}

async function systemd(run: Runner, args: readonly string[]): Promise<void> {
  const result = await systemctl(run, args);
  if (result.code) throw managerFailure(result.code, result.stderr);
}
