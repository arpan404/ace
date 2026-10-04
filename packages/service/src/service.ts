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
    return checked(
      this.run,
      this.plan.platform === "darwin" ? "launchctl" : "systemctl",
      this.plan.platform === "darwin" ? args : ["--user", ...args],
    );
  }
  async active(): Promise<boolean> {
    await this.validate();
    const mac = this.plan.platform === "darwin";
    const r = await this.run(
      mac ? "launchctl" : "systemctl",
      mac
        ? ["print", this.plan.domain]
        : ["--user", "show", this.plan.domain, `--property=${loadedProperties}`],
    );
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
    throw new Error(`Cannot query user service: ${r.stderr}`);
  }
  async perform(action: ServiceAction): Promise<{ active: boolean }> {
    await this.validate();
    const p = this.plan,
      mac = p.platform === "darwin";
    if (action === "status") return { active: await this.active() };
    if (action === "install") {
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
