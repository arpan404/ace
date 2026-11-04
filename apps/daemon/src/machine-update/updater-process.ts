import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { MachineInstall } from "@ace/protocol";
import { ReleaseVersion } from "@ace/protocol";
import { planUpdateLaunch } from "@ace/service";
import { desktopAppMarker } from "@ace/service/desktop-update";
import { cliOrigin } from "../doctor/install-versions.ts";
import type { UpdaterPorts } from "./standalone-installer.ts";
import type { RecordStore } from "./record.ts";

export type Spawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * What kind of install runs this daemon, from its entry script: the desktop app's bundled
 * daemon has the app's marker beside it; a standalone release lives under
 * `releases/<version>-<target>/`; anything else is a checkout.
 */
export function detectInstall(
  entry: string | undefined,
  exists: (path: string) => boolean = existsSync,
): MachineInstall {
  if (!entry) return "source";
  if (exists(join(dirname(entry), desktopAppMarker))) return "desktop";
  return cliOrigin(entry)?.kind === "release" ? "standalone" : "source";
}

const CheckOutput = z.looseObject({ version: ReleaseVersion });
const checkTimeoutMs = 120_000;

/**
 * The standalone updater run as this release's own CLI (`node ace.mjs update …`), so the signed
 * check, the transaction and its rollback are exactly `ace update`'s. `apply` runs outside this
 * daemon's process tree (a transient systemd unit, or detached), since it stops the service.
 */
export function updaterProcess(options: {
  node: string;
  entry: string;
  root: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  spawn: Spawner;
  record: Pick<RecordStore, "takeOutcome">;
}): UpdaterPorts {
  const { node, entry, spawn } = options;
  return {
    check: () =>
      new Promise((resolve, reject) => {
        const child = spawn(node, [entry, "update", "check"], {
          stdio: ["ignore", "pipe", "pipe"],
          env: options.env,
          timeout: checkTimeoutMs,
        });
        let output = "";
        let errors = "";
        child.stdout?.setEncoding("utf8").on("data", (part: string) => {
          if (output.length < 64 * 1024) output += part;
        });
        child.stderr?.setEncoding("utf8").on("data", (part: string) => {
          if (errors.length < 4096) errors += part;
        });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code !== 0) {
            reject(new Error(errors.trim() || `ace update check exited with ${code}`));
            return;
          }
          try {
            resolve(CheckOutput.parse(JSON.parse(output.trim().split("\n").at(-1) ?? "")));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }),
    launch(mode) {
      const launch = planUpdateLaunch({
        platform: options.platform,
        env: options.env,
        node,
        args: [entry, "update", "apply", mode === "now" ? "--interrupt" : "--drain", "--outcome"],
        root: options.root,
      });
      const child = spawn(launch.command, launch.args, {
        stdio: "ignore",
        detached: launch.detached,
        windowsHide: true,
        env: options.env,
      });
      child.unref();
      return {
        exited: new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        }),
      };
    },
    takeOutcome: () => options.record.takeOutcome(),
  };
}

/** The server's `machineUpdate` option for this process: its install, record and updater. */
export function machineUpdateConfig(options: {
  dataDir: string;
  entry: string | undefined;
  node: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  spawn: Spawner;
  record: RecordStore;
}) {
  const install = detectInstall(options.entry);
  const { entry } = options;
  return {
    install,
    record: options.record,
    ...(install === "standalone" && entry
      ? {
          updater: updaterProcess({
            node: options.node,
            entry,
            root: options.dataDir,
            platform: options.platform,
            env: options.env,
            spawn: options.spawn,
            record: options.record,
          }),
        }
      : {}),
  };
}
