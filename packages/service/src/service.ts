import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type ServicePlan } from "./plan.ts";
import { assertCompatibleHome } from "./home.ts";
import { readRegistration } from "./compatibility.ts";
import {
  assertRegistration,
  assertLoadedService,
  incompatibleService,
  loadedProperties,
} from "./service-identity.ts";
import { checked, type Runner } from "./process.ts";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import type { TaskPlan } from "./plan.ts";
import { readTaskRecord } from "./compatibility.ts";
import {
  assertLoadedTask,
  assertTaskRegistration,
  incompatibleTask,
  taskActive,
} from "./service-identity.ts";
/** `systemctl --user` found no user manager: containers, WSL without systemd, `su` shells. */
const noUserManager =
  /Failed to connect to (?:user scope )?bus|\$DBUS_SESSION_BUS_ADDRESS|\$XDG_RUNTIME_DIR|No medium found/;

const noSession =
  "ace's service needs a systemd user session (systemctl --user), and this environment has none, as is common in containers and WSL without systemd. Run the daemon in the foreground with `ace start` instead, or log in through a session that starts systemd --user.";

function managerFailure(code: number, stderr: string): Error {
  if (noUserManager.test(stderr)) return new Error(noSession);
  return new Error(`systemctl failed (${code}): ${stderr}`);
}

/** Runs `systemctl --user`; a system without systemctl at all has no user session either. */
async function systemctl(run: Runner, args: readonly string[]) {
  try {
    return await run("systemctl", ["--user", ...args]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error(noSession, { cause: error });
    throw error;
  }
}
export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "status";
export class UserService {
  private readonly plan: ServicePlan;
  private readonly run: Runner;
  private readonly preflight: () => Promise<void>;
  constructor(plan: ServicePlan, run: Runner, preflight: () => Promise<void> = async () => {}) {
    this.plan = plan;
    this.run = run;
    this.preflight = preflight;
  }
  private async validate(): Promise<void> {
    // These guards are mandatory even when a caller supplies only a plan and manager runner.
    assertCompatibleHome(dirname(this.plan.logDir));
    assertCompatibleHome(dirname(dirname(this.plan.command[0])));
    await this.preflight();
    const content = readRegistration(this.plan);
    if (content !== undefined) assertRegistration(this.plan, content);
  }
  private async call(args: string[]) {
    if (this.plan.platform === "darwin") return checked(this.run, "launchctl", args);
    const result = await systemctl(this.run, args);
    if (result.code) throw managerFailure(result.code, result.stderr);
    return result;
  }
  async active(): Promise<boolean> {
    await this.validate();
    const mac = this.plan.platform === "darwin";
    const r = mac
      ? await this.run("launchctl", ["print", this.plan.domain])
      : await systemctl(this.run, ["show", this.plan.domain, `--property=${loadedProperties}`]);
    if (r.code === 0) {
      const active = assertLoadedService(this.plan, r.stdout);
      if (
        (mac || /(?:^|\n)LoadState=loaded(?:\n|$)/.test(r.stdout)) &&
        readRegistration(this.plan) === undefined
      )
        throw incompatibleService(this.plan);
      return active;
    }
    if (mac ? r.code === 113 : r.code === 4) return false;
    if (!mac && noUserManager.test(r.stderr)) throw managerFailure(r.code, r.stderr);
    throw new Error(`Cannot query user service: ${r.stderr}`);
  }
  async perform(action: ServiceAction): Promise<{ active: boolean }> {
    await this.validate();
    const p = this.plan,
      mac = p.platform === "darwin";
    if (action === "status") return { active: await this.active() };
    if (action === "install") {
      // A matching file does not prove the manager loaded that program. Validate
      // before enable or any registration/filesystem mutation, including reinstalls.
      await this.active();
      await mkdir(dirname(p.file), { recursive: true });
      await mkdir(p.logDir, { recursive: true, mode: 0o700 });
      const existing = readRegistration(p);
      if (existing !== p.content) {
        // Re-register only changed plans; an unchanged reinstall leaves the daemon running.
        await this.perform("stop");
        await writeFile(p.file + ".tmp", p.content, { mode: 0o600 });
        await rename(p.file + ".tmp", p.file);
        if (!mac) await this.call(["daemon-reload"]);
      }
      if (!mac) await this.call(["enable", p.domain]);
      return this.perform("start");
    }
    if (action === "start") {
      if (!(await this.active()))
        await this.call(
          mac
            ? ["bootstrap", p.domain.slice(0, p.domain.lastIndexOf("/")), p.file]
            : ["start", p.domain],
        );
    } else {
      if (await this.active()) await this.call(mac ? ["bootout", p.domain] : ["stop", p.domain]);
      if (action === "uninstall") {
        // Disable only when the managed unit still exists; a second removal is a no-op.
        const exists = readRegistration(p) !== undefined;
        if (exists && !mac) await this.call(["disable", p.domain]);
        await rm(p.file, { force: true });
        if (exists && !mac) await this.call(["daemon-reload"]);
      }
    }
    return { active: await this.active() };
  }
}

export interface TaskPorts {
  run: Runner;
  /** Checks the home and ace's task record before anything is changed. */
  preflight(): Promise<void>;
  /** Asks the running daemon to shut down (`POST /v1/stop`); false when it did not accept. */
  requestStop(): Promise<boolean>;
  wait(ms: number): Promise<void>;
}

/**
 * The Windows login service: a per-user Task Scheduler task (`TaskPlan`), managed with
 * `schtasks.exe` and validated against ace's record like the launchd and systemd services.
 */
export class TaskService {
  private readonly plan: TaskPlan;
  private readonly ports: TaskPorts;
  constructor(plan: TaskPlan, ports: TaskPorts) {
    this.plan = plan;
    this.ports = ports;
  }
  private async validate(): Promise<void> {
    assertCompatibleHome(win32.dirname(this.plan.logDir));
    assertCompatibleHome(win32.dirname(win32.dirname(this.plan.command[0])));
    await this.ports.preflight();
    const content = readTaskRecord(this.plan);
    if (content !== undefined) assertTaskRegistration(this.plan, content);
  }
  private async schtasks(args: readonly string[]) {
    return this.ports.run("schtasks.exe", args);
  }
  /** Whether Task Scheduler holds ace's task; a task by that name ace did not register is refused. */
  private async registered(): Promise<boolean> {
    const query = await this.schtasks(["/Query", "/TN", this.plan.name, "/XML"]);
    if (query.code === 0) {
      assertLoadedTask(this.plan, query.stdout);
      if (readTaskRecord(this.plan) === undefined) throw incompatibleTask(this.plan);
      return true;
    }
    // schtasks reports a missing task only in localized words, so look for it in the list.
    const list = await this.schtasks(["/Query", "/FO", "CSV", "/NH"]);
    if (list.code !== 0) throw new Error(`Cannot query the service task: ${list.stderr}`);
    const name = `"${this.plan.name.toLowerCase()}"`;
    if (list.stdout.split(/\r?\n/).some((line) => line.toLowerCase().startsWith(name)))
      throw new Error(`Cannot query the service task: ${query.stderr}`);
    return false;
  }
  private async running(): Promise<boolean> {
    if (!(await this.registered())) return false;
    const status = await checked(this.ports.run, "schtasks.exe", [
      "/Query",
      "/TN",
      this.plan.name,
      "/V",
      "/FO",
      "CSV",
      "/NH",
    ]);
    return taskActive(this.plan, status.stdout);
  }
  private async until(running: boolean, ms: number): Promise<boolean> {
    for (let waited = 0; waited < ms; waited += 250) {
      if ((await this.running()) === running) return true;
      await this.ports.wait(250);
    }
    return (await this.running()) === running;
  }
  async active(): Promise<boolean> {
    await this.validate();
    return this.running();
  }
  async perform(action: ServiceAction): Promise<{ active: boolean }> {
    await this.validate();
    const p = this.plan;
    if (action === "status") return { active: await this.running() };
    if (action === "install") {
      const registered = await this.registered();
      await mkdir(win32.dirname(p.file), { recursive: true });
      await mkdir(p.logDir, { recursive: true });
      const record = readTaskRecord(p);
      const environment = await readFile(p.environmentFile, "utf8").catch(() => undefined);
      if (!registered || record !== p.content || environment !== p.environment) {
        // Re-register only changed plans; an unchanged reinstall leaves the daemon running.
        await this.perform("stop");
        await replaceFile(p.environmentFile, p.environment);
        // The record goes first: a task without one is never adopted.
        await replaceFile(p.file, p.content);
        const xml = p.file + ".import";
        // schtasks reads task XML as UTF-16.
        await writeFile(
          xml,
          Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(p.content, "utf16le")]),
        );
        try {
          await checked(this.ports.run, "schtasks.exe", [
            "/Create",
            "/TN",
            p.name,
            "/XML",
            xml,
            "/F",
          ]);
        } finally {
          await rm(xml, { force: true });
        }
      }
      return this.perform("start");
    }
    if (action === "start") {
      if (!(await this.running())) {
        await checked(this.ports.run, "schtasks.exe", ["/Run", "/TN", p.name]);
        await this.until(true, 10_000);
      }
    } else {
      if (await this.running()) await this.stop();
      if (action === "uninstall") {
        if (await this.registered())
          await checked(this.ports.run, "schtasks.exe", ["/Delete", "/TN", p.name, "/F"]);
        await rm(p.file, { force: true });
        await rm(p.environmentFile, { force: true });
      }
    }
    return { active: await this.running() };
  }
  /**
   * The daemon shuts down through its own stop request: `schtasks /End` ends only the task's
   * first process, as `TerminateProcess`, skipping the daemon's shutdown. `/End` is the
   * fallback for a daemon that does not answer.
   */
  private async stop(): Promise<void> {
    if ((await this.ports.requestStop()) && (await this.until(false, 60_000))) return;
    await checked(this.ports.run, "schtasks.exe", ["/End", "/TN", this.plan.name]);
    if (!(await this.until(false, 10_000))) throw new Error("The service task did not stop");
  }
}

async function replaceFile(path: string, content: string): Promise<void> {
  await writeFile(path + ".tmp", content);
  await rename(path + ".tmp", path);
}
