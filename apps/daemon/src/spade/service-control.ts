import { z } from "zod";
import type { SpadeServiceState } from "./rules.ts";

/**
 * Spade's registration with the OS service manager (ADR 0123, decision 2), as the daemon and
 * `ace spade on|off` use it. Production is `@ace/service`; tests pass a fake.
 */
export interface SpadeServiceControl {
  state(): Promise<SpadeServiceState>;
  /** Copies this release's `spade-server` to `<ACE_HOME>/releases/spade/<version>/` if missing. */
  installBinary(): Promise<void>;
  /** Registers and starts the service; registering again leaves a running Spade alone. */
  register(): Promise<void>;
  /** Stops the service and removes its registration. */
  remove(): Promise<void>;
}

const State = z.enum(["absent", "stopped", "running"]);
type Callable = (...args: unknown[]) => unknown;
const callable = (value: unknown): value is Callable => typeof value === "function";

/**
 * `@ace/service`'s Spade API, by the contract's names (spade/docs/ace-integration.md):
 * `spadeServicePlan(home, platform)`, `installSpadeService(plan)`, `removeSpadeService(plan)`,
 * `spadeServiceState(plan)` and `installSpadeBinary(home)`. Looked up when first used, so a build
 * without them says so instead of failing to start.
 */
export function aceSpadeService(home: string, platform: NodeJS.Platform): SpadeServiceControl {
  let loaded: Promise<{ plan: unknown; api: Record<string, Callable> }> | undefined;
  const load = () =>
    (loaded ??= import("@ace/service").then((module) => {
      const names = [
        "spadeServicePlan",
        "installSpadeService",
        "removeSpadeService",
        "spadeServiceState",
        "installSpadeBinary",
      ] as const;
      const api: Record<string, Callable> = {};
      for (const name of names) {
        const value: unknown = Reflect.get(module, name);
        if (!callable(value))
          throw new Error("This build of ace can't register Spade as a service yet.");
        api[name] = value;
      }
      return { plan: api.spadeServicePlan?.(home, platform), api };
    }));
  const run = async (name: string, ...args: unknown[]) => {
    const { plan, api } = await load();
    return api[name]?.(...(args.length ? args : [plan]));
  };
  return {
    state: async () => State.parse(await run("spadeServiceState")),
    installBinary: async () => {
      await run("installSpadeBinary", home);
    },
    register: async () => {
      await run("installSpadeService");
    },
    remove: async () => {
      await run("removeSpadeService");
    },
  };
}
