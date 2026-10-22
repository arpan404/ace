import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { appArmorSetupScript } from "@ace/browser/linux-sandbox";
import type { SandboxNotice } from "../../shared/contract.ts";
import {
  afterSetup,
  appProfile,
  browserProfile,
  commandsNotice,
  linuxInstall,
  offer,
  profilesToInstall,
  type SandboxFacts,
} from "./linux-sandbox.ts";

/** A way to run the setup as root that asks the person through their desktop's prompt. */
export interface Elevation {
  kind: "pkexec" | "run0";
  path: string;
}
/** pkexec (polkit's own) first, else systemd's run0 (systemd 256+), from PATH. */
export function findElevation(
  path: string | undefined,
  executable: (file: string) => boolean = isExecutable,
): Elevation | undefined {
  const dirs = (path ?? "").split(delimiter).filter((dir) => isAbsolute(dir));
  for (const kind of ["pkexec", "run0"] as const)
    for (const dir of dirs) if (executable(join(dir, kind))) return { kind, path: join(dir, kind) };
  return undefined;
}
function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The outcome of one elevated run: pkexec exits 126 when the person dismisses its prompt. */
export type ElevatedRun = (elevation: Elevation, args: string[]) => Promise<number | null>;
export const runElevated: ElevatedRun = (elevation, args) =>
  new Promise((done) => {
    execFile(
      elevation.path,
      ["/bin/sh", "-c", appArmorSetupScript, "ace-sandbox-setup", ...args],
      { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 },
      (error) => {
        if (!error) return done(0);
        done("code" in error && typeof error.code === "number" ? error.code : null);
      },
    );
  });

/** What this launch knows about its sandbox, read once at startup. */
export function readSandboxFacts(options: {
  env: Readonly<Record<string, string | undefined>>;
  execPath: string;
  noSandbox: boolean;
  uid: number;
  home: string;
  /** The local daemon's ACE_HOME; undefined for a remote daemon. */
  dataDir: string | undefined;
  readText?: (path: string) => string | undefined;
}): SandboxFacts {
  const readText = options.readText ?? readTextFile;
  const chromiumPath = options.env.ACE_CHROMIUM_PATH;
  const browser =
    options.dataDir !== undefined && options.env.ACE_CHROMIUM_NO_SANDBOX !== "1"
      ? browserProfile({
          dataDir: resolve(options.dataDir),
          home: options.home,
          ...(chromiumPath ? { chromiumPath: resolve(chromiumPath) } : {}),
        })
      : undefined;
  const app = appProfile(linuxInstall(options.env, options.execPath), options.uid);
  return {
    restricted: readText("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")?.trim() === "1",
    appUnsandboxed: options.noSandbox,
    ...(app ? { app } : {}),
    ...(browser ? { browser } : {}),
    installed: (name) => readText(`/etc/apparmor.d/${name}`),
  };
}
function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export interface LinuxSandboxSetupOptions {
  facts: SandboxFacts;
  elevation: Elevation | undefined;
  /** Runs the setup script as root; tests stand in for pkexec here. */
  run?: ElevatedRun;
  report: (notice: SandboxNotice) => void;
  log: (message: string) => void;
}

/** The notice the app shows and the setup behind its button. */
export class LinuxSandboxSetup {
  private notice: SandboxNotice;
  private running: Promise<SandboxNotice> | undefined;
  private readonly options: LinuxSandboxSetupOptions;
  constructor(options: LinuxSandboxSetupOptions) {
    this.options = options;
    this.notice = offer(profilesToInstall(options.facts));
  }

  current(): SandboxNotice {
    return this.notice;
  }

  hide(): SandboxNotice {
    // A setup waiting on the password prompt keeps its notice: its result still lands.
    if (this.notice.state !== "working") this.set({ state: "hidden" });
    return this.notice;
  }

  setup(): Promise<SandboxNotice> {
    this.running ??= this.elevate().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async elevate(): Promise<SandboxNotice> {
    const profiles = profilesToInstall(this.options.facts);
    if (profiles.length === 0) return this.set({ state: "hidden" });
    const elevation = this.options.elevation;
    if (!elevation) return this.set(commandsNotice(profiles, "no-prompt"));
    const previous = this.notice;
    this.set({ state: "working", sentence: "Waiting for your password to set up the sandbox." });
    const code = await (this.options.run ?? runElevated)(
      elevation,
      profiles.flatMap(({ name, text }) => [name, text]),
    );
    if (code === 0) {
      this.options.log(`Sandbox profiles installed: ${profiles.map((p) => p.name).join(", ")}`);
      return this.set(afterSetup(profiles));
    }
    // pkexec: the person dismissed the prompt. Nothing changed; the offer stands.
    if (elevation.kind === "pkexec" && code === 126) return this.set(previous);
    this.options.log(`Sandbox setup through ${elevation.kind} failed (exit ${String(code)})`);
    return this.set(commandsNotice(profiles, "failed"));
  }

  private set(notice: SandboxNotice): SandboxNotice {
    this.notice = notice;
    this.options.report(notice);
    return notice;
  }
}
