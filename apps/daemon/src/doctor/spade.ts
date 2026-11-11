import type { CheckResult } from "@ace/diagnostics";
import {
  installedSpadeVersion,
  localSpadePlan,
  spadeServiceState,
  type SpadeServiceState,
} from "@ace/service/spade";
import { spadeDisabled } from "../services/spade.ts";
import type { DoctorContext, DoctorFeature } from "./feature.ts";
import { cliVersion } from "./install.ts";

type Verdict = Omit<CheckResult, "id">;

/** What Spade's checks read, so tests can stand in for the service manager and the CLI. */
export type SpadePorts = {
  state(home: string): Promise<SpadeServiceState>;
  installed(home: string): Promise<string | undefined>;
  aceVersion(context: DoctorContext): Promise<string>;
};

export const systemSpadePorts: SpadePorts = {
  state: async (home) => spadeServiceState(await localSpadePlan(home)),
  installed: installedSpadeVersion,
  aceVersion: (context) => cliVersion(context.env, process.argv[1]),
};

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const logHint = "Its log is logs/spade.log in ace's data folder.";

const nothing = "Nothing to do.";
const serviceFix = `Turn Spade off and on again in Settings, or run ace spade on. ${logHint}`;
const binaryFix = "Run ace update apply, or restart the ace app, to install Spade's binary again.";

/** Spade's service (registered beside the daemon's) as the service manager reports it. */
export function spadeServiceVerdict(state: SpadeServiceState): Verdict {
  if (state === "running")
    return { status: "ok", message: "Spade's service is running.", fix: nothing };
  if (state === "absent")
    return { status: "ok", message: "Spade is off: its service isn't registered.", fix: nothing };
  return {
    status: "warn",
    message: "Spade's service is registered but not running.",
    fix: serviceFix,
  };
}

/** Spade's installed binary against the service and ace's own version. */
export function spadeBinaryVerdict(
  state: SpadeServiceState | undefined,
  installed: string | undefined,
  ace: string,
): Verdict {
  if (installed === undefined)
    return state === undefined || state === "absent"
      ? { status: "ok", message: "Spade's binary isn't installed (Spade is off).", fix: nothing }
      : {
          status: "fail",
          message: "Spade's service is registered, but its binary is missing.",
          fix: binaryFix,
        };
  if (ace !== "development" && installed !== ace)
    return {
      status: "warn",
      message: `Spade is at ${installed} and ace at ${ace}.`,
      fix: "Run ace update apply, or restart the ace app: Spade follows ace's version.",
    };
  return { status: "ok", message: `Spade ${installed} is installed.`, fix: nothing };
}

const failure = (error: unknown, fix: string): Verdict => ({
  status: "fail",
  message: reason(error),
  fix,
});
const leftOut: Verdict = { status: "ok", message: "This build leaves Spade out.", fix: nothing };

/**
 * `ace doctor`'s Spade checks (ADR 0123): its service, the way the install checks cover the
 * daemon's, and the binary that service runs. Read-only.
 */
export function spadeFeature(ports: SpadePorts): DoctorFeature {
  return {
    id: "spade",
    checks(context) {
      const home = context.config.dataDir;
      const off = spadeDisabled(context.env);
      let state: Promise<SpadeServiceState> | undefined;
      const read = () => (state ??= ports.state(home));
      return [
        {
          id: "spade.service",
          fix: serviceFix,
          async run(): Promise<Verdict> {
            if (off) return leftOut;
            try {
              return spadeServiceVerdict(await read());
            } catch (error) {
              return failure(error, serviceFix);
            }
          },
        },
        {
          id: "spade.binary",
          fix: binaryFix,
          async run(): Promise<Verdict> {
            if (off) return leftOut;
            let installed: string | undefined;
            try {
              installed = await ports.installed(home);
            } catch (error) {
              return failure(error, binaryFix);
            }
            const known = await read().catch(() => undefined);
            return spadeBinaryVerdict(known, installed, await ports.aceVersion(context));
          },
        },
      ];
    },
  };
}

export const spade: DoctorFeature = spadeFeature(systemSpadePorts);
