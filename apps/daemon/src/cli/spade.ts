import type { SpadeStatus } from "@ace/protocol";
import { betaKeys, betaOnAtRest, booleanAtRest } from "@ace/settings/beta";
import { cliVersion } from "../doctor/install.ts";
import { aceSpadeService, type SpadeServiceControl } from "../spade/service-control.ts";
import type { Args } from "./args.ts";
import { daemonRuns, saveGlobalSetting } from "./global-setting.ts";
import { CliFailure } from "./output.ts";

/** Spade's service on this machine, as the release lays it out. */
export function spadeService(home: string): SpadeServiceControl {
  return aceSpadeService({
    home,
    env: process.env,
    version: () => cliVersion(process.env, process.argv[1]),
    entry: process.argv[1],
  });
}

export interface SpadeSwitch {
  enabled: boolean;
  live: boolean;
  /** `spade on` turned Settings › Beta's Spade switch on first. */
  beta?: true;
}

/** How `spade on` asks before it also turns the Beta switch on; absent off a terminal. */
export type AskBeta = () => Promise<boolean>;

/**
 * `ace spade on|off` (ADR 0123, ADR 0176 §8): the same switch as Settings. A running daemon
 * applies it at once: it registers or removes Spade's service and makes or retires Spade's
 * grant. With no daemon running the CLI registers or removes the service itself and saves the
 * setting; the daemon makes or retires the grant when it next starts. `on` while Settings › Beta
 * hides Spade turns that on too: after one question on a terminal, with `--yes` anywhere else.
 */
export async function switchSpade(
  args: Args,
  home: string,
  enabled: boolean,
  service: SpadeServiceControl,
  askBeta?: AskBeta,
): Promise<SpadeSwitch> {
  let beta = false;
  if (enabled && !(await betaOnAtRest(home, "spade"))) {
    const yes = args.flags.yes === true || (askBeta ? await askBeta() : false);
    if (!yes)
      throw new CliFailure(
        askBeta ? "failed" : "refused",
        askBeta
          ? "Spade stays off. Nothing was changed."
          : "Spade is turned off in Settings › Beta, so it can't be turned on.",
        undefined,
        askBeta
          ? { code: "failed" }
          : {
              code: "turned_off",
              hint: "Pass --yes to turn on the Beta switch too, or run ace feature on spade first.",
            },
      );
    await saveGlobalSetting(args, home, betaKeys.spade, true, "Spade");
    beta = true;
  }
  const live = await saveGlobalSetting(args, home, "spade.enabled", enabled, "Spade", async () => {
    if (enabled && (await service.state()) !== "running") {
      await service.installBinary();
      await service.register();
    }
  });
  if (!live && !enabled && (await service.state()) !== "absent") await service.remove();
  return { enabled, live, ...(beta ? { beta: true as const } : {}) };
}

export interface SpadeState {
  beta: boolean;
  enabled: boolean;
  live: boolean;
  status?: SpadeStatus;
}

/**
 * Where Spade stands: the two switches, and Spade's own state from the daemon when one runs.
 * Nothing is started or written to find out.
 */
export async function spadeState(
  args: Args,
  home: string,
  daemon: () => Promise<{ beta: boolean; enabled: boolean; status: SpadeStatus }>,
): Promise<SpadeState> {
  if (args.flags.remote || (await daemonRuns(home))) return { ...(await daemon()), live: true };
  const [beta, enabled] = await Promise.all([
    betaOnAtRest(home, "spade"),
    booleanAtRest(home, "spade.enabled"),
  ]);
  return { beta, enabled: enabled === true, live: false };
}
