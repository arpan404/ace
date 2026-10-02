import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type ServicePlan } from "./plan.ts";
import { checked, type Runner } from "./process.ts";
export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "status";
export class UserService {
  private readonly plan: ServicePlan;
  private readonly run: Runner;
  constructor(plan: ServicePlan, run: Runner) {
    this.plan = plan;
    this.run = run;
  }
  private async call(args: string[]) {
    return checked(
      this.run,
      this.plan.platform === "darwin" ? "launchctl" : "systemctl",
      this.plan.platform === "darwin" ? args : ["--user", ...args],
    );
  }
  async active(): Promise<boolean> {
    const mac = this.plan.platform === "darwin";
    const r = await this.run(
      mac ? "launchctl" : "systemctl",
      mac ? ["print", this.plan.domain] : ["--user", "is-active", "ace.service"],
    );
    if (r.code === 0) return true;
    if (mac ? r.code === 113 : r.code === 3 || r.code === 4) return false;
    throw new Error(`Cannot query user service: ${r.stderr}`);
  }
  async perform(action: ServiceAction): Promise<{ active: boolean }> {
    const p = this.plan,
      mac = p.platform === "darwin";
    if (action === "status") return { active: await this.active() };
    if (action === "install") {
      await mkdir(dirname(p.file), { recursive: true });
      await mkdir(p.logDir, { recursive: true, mode: 0o700 });
      let existing: string | undefined;
      try {
        existing = await readFile(p.file, "utf8");
      } catch (e) {
        if (!missing(e)) throw e;
      }
      if (existing !== p.content) {
        // Re-register only changed plans; an unchanged reinstall leaves the daemon running.
        await this.perform("stop");
        await writeFile(p.file + ".tmp", p.content, { mode: 0o600 });
        await rename(p.file + ".tmp", p.file);
        if (!mac) await this.call(["daemon-reload"]);
      }
      if (!mac) await this.call(["enable", "ace.service"]);
      return this.perform("start");
    }
    if (action === "start") {
      if (!(await this.active()))
        await this.call(
          mac
            ? ["bootstrap", p.domain.slice(0, p.domain.lastIndexOf("/")), p.file]
            : ["start", "ace.service"],
        );
    } else {
      if (await this.active())
        await this.call(mac ? ["bootout", p.domain] : ["stop", "ace.service"]);
      if (action === "uninstall") {
        // Disable only when the managed unit still exists; a second removal is a no-op.
        let exists = true;
        try {
          await readFile(p.file);
        } catch (e) {
          if (!missing(e)) throw e;
          exists = false;
        }
        if (exists && !mac) await this.call(["disable", "ace.service"]);
        await rm(p.file, { force: true });
        if (exists && !mac) await this.call(["daemon-reload"]);
      }
    }
    return { active: await this.active() };
  }
}
function missing(e: unknown) {
  return e instanceof Error && "code" in e && e.code === "ENOENT";
}
