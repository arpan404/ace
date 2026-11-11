import { execFile } from "node:child_process";
import { join } from "node:path";
import { spadeBinaryName } from "@ace/service/spade-plan";

/**
 * After the app starts its daemon, Spade follows it to the app's version (ADR 0123): the daemon
 * is swapped first (the restart into the update), then Spade, so both are never stopped at
 * once. The swap runs in the bundled CLI (`spade-follow`) on the bundled runtime, which has the
 * updater's natives; Spade's service absent, or a build without Spade, makes it a no-op.
 */
export async function followDaemonWithSpade(options: {
  home: string;
  resourcesPath: string;
  version: string;
  platform: NodeJS.Platform;
  /** The bundled runtime and the daemon bundle's `ace.mjs`. */
  node: string;
  entry: string;
  env: NodeJS.ProcessEnv;
  daemonReady(): Promise<unknown>;
  log(level: "info" | "warn", message: string): void;
}): Promise<void> {
  await options.daemonReady();
  const source = join(options.resourcesPath, "spade", spadeBinaryName(options.platform));
  await new Promise<void>((resolve) => {
    execFile(
      options.node,
      [options.entry, "spade-follow", source, options.version],
      {
        env: { ...options.env, ACE_HOME: options.home },
        timeout: 15 * 60_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const line = `${stdout}${stderr}`.trim().slice(0, 4096);
        if (error) options.log("warn", `Spade's update failed: ${line || error.message}`);
        else if (line) options.log("info", line);
        resolve();
      },
    );
  });
}
