import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  installSpadeBinary,
  installSpadeService,
  installedSpadeVersion,
  localSpadePlan,
  removeSpadeService,
  spadeBinaryName,
  spadeServiceState,
} from "@ace/service/spade-service";
import type { SpadeServiceState } from "./rules.ts";

/**
 * Spade's registration with the OS service manager (ADR 0123, decision 2), as the daemon and
 * `ace spade on|off` use it. Production is `@ace/service`; tests pass a fake.
 */
export interface SpadeServiceControl {
  state(): Promise<SpadeServiceState>;
  /** Copies this release's `spade-server` to `<ACE_HOME>/releases/spade/<version>/` if missing. */
  installBinary(): Promise<void>;
  /** Registers and starts the service; an unchanged one that runs is left running. */
  register(): Promise<void>;
  /** Stops the service and removes its registration. */
  remove(): Promise<void>;
}

/**
 * The `spade-server` this release carries: `ACE_SPADE_BIN` in development, else the one beside
 * the runtime in the release bundle (`bin/node`, `bin/spade-server`).
 */
export function bundledSpadeBinary(
  env: Readonly<Record<string, string | undefined>>,
  runtime: string,
  platform: NodeJS.Platform,
): string {
  return env.ACE_SPADE_BIN?.trim() || join(dirname(runtime), spadeBinaryName(platform));
}

/**
 * The release folder Spade's binary is installed as. A release's binary is stamped with ace's
 * version; a development build (`ACE_SPADE_BIN`) reports its own stamp, and installing it under
 * any other name would make the updater's health check (which compares the two) fail.
 */
export async function spadeInstallVersion(
  env: Readonly<Record<string, string | undefined>>,
  aceVersion: () => Promise<string>,
  binaryVersion: (binary: string) => Promise<string>,
): Promise<string> {
  const development = env.ACE_SPADE_BIN?.trim();
  if (!development) return aceVersion();
  const reported = (await binaryVersion(development)).trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(reported))
    throw new Error(`${development} --version answered "${reported.slice(0, 80)}"`);
  return reported;
}

async function versionOf(binary: string): Promise<string> {
  const { stdout } = await promisify(execFile)(binary, ["--version"], { timeout: 5_000 });
  return stdout;
}

/** `@ace/service`'s Spade service for `home` on this machine and account. */
export function aceSpadeService(input: {
  home: string;
  /** `ACE_SPADE_BIN` is read from it. */
  env: Readonly<Record<string, string | undefined>>;
  /** ace's version: the release folder a release's binary is installed as. */
  version(): Promise<string>;
}): SpadeServiceControl {
  let plan: ReturnType<typeof localSpadePlan> | undefined;
  const planned = () => (plan ??= localSpadePlan(input.home));
  return {
    state: async () => spadeServiceState(await planned()),
    async installBinary() {
      if ((await installedSpadeVersion(input.home)) !== undefined) return;
      const source = bundledSpadeBinary(input.env, process.execPath, process.platform);
      const version = await spadeInstallVersion(input.env, input.version, versionOf);
      await installSpadeBinary(input.home, source, version);
    },
    async register() {
      await installSpadeService(await planned());
    },
    async remove() {
      await removeSpadeService(await planned());
    },
  };
}
