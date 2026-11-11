import { dirname, join } from "node:path";
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

/** `@ace/service`'s Spade service for `home` on this machine and account. */
export function aceSpadeService(input: {
  home: string;
  /** `ACE_SPADE_BIN` is read from it. */
  env: Readonly<Record<string, string | undefined>>;
  /** ace's version: the release folder the binary is installed as. */
  version(): Promise<string>;
}): SpadeServiceControl {
  let plan: ReturnType<typeof localSpadePlan> | undefined;
  const planned = () => (plan ??= localSpadePlan(input.home));
  return {
    state: async () => spadeServiceState(await planned()),
    async installBinary() {
      if ((await installedSpadeVersion(input.home)) !== undefined) return;
      const source = bundledSpadeBinary(input.env, process.execPath, process.platform);
      await installSpadeBinary(input.home, source, await input.version());
    },
    async register() {
      await installSpadeService(await planned());
    },
    async remove() {
      await removeSpadeService(await planned());
    },
  };
}
