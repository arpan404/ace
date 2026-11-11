import type { SpadeGrantDelivery } from "../spade/delivery.ts";
import type { SpadeGrants } from "../spade/grant.ts";
import type { SpadeHostThread } from "../spade/host-thread.ts";
import type { SpadeLink } from "../spade/link.ts";
import type { SpadeServiceControl } from "../spade/service-control.ts";

export interface SpadeSwitchDeps {
  service: SpadeServiceControl;
  link: Pick<SpadeLink, "setEnabled" | "setSwitch" | "ready">;
  grants: Pick<SpadeGrants, "current" | "ensure" | "wanted" | "retireAll">;
  host: { ensure(): Promise<SpadeHostThread | undefined> };
  delivery: Pick<SpadeGrantDelivery, "deliver" | "withdraw">;
  /** Ends the grant's lease on the MCP endpoint. */
  endLease(): void;
  now(): number;
  log(level: "info" | "warn", message: string): void;
}
/** `changed`: the person flipped `spade.enabled`. `started`: the daemon read it at start. */
export type SpadeSwitchCause = "changed" | "started";

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * `spade.enabled`, applied (ADR 0123, decision 2; contract, "On and off"). On: install the binary
 * copy and register the service if Spade isn't running, heal the host thread and make the grant,
 * then hand it to Spade. Off: retire the grant, tell Spade to forget it, and remove the service.
 * At daemon start the same steps reconcile what changed while it was down (`ace spade on|off`
 * without a daemon); a grant the person revoked is not remade until Spade is turned on again.
 * Changes apply one at a time, in order.
 */
export function spadeSwitch(deps: SpadeSwitchDeps) {
  let queue: Promise<void> = Promise.resolve();

  async function on(cause: SpadeSwitchCause): Promise<void> {
    const { service, link, grants } = deps;
    link.setEnabled(true);
    link.setSwitch({ installing: true });
    let problem: string | undefined;
    let made = false;
    // Whatever fails, `installing` is cleared and the failure shows as `failed`: Spade never
    // stays `starting` because a step threw.
    try {
      try {
        if ((await service.state()) !== "running") {
          await service.installBinary();
          await service.register();
        }
      } catch (error) {
        problem = `Spade couldn't be registered as a service: ${words(error)}`;
      }
      const make = cause === "changed" ? grants.current() === undefined : grants.wanted();
      // The host thread is made or healed with the grant; a live grant's heals at start too.
      if (make || grants.current()) await deps.host.ensure();
      if (make) {
        grants.ensure();
        made = true;
        deps.log("info", "Made Spade's grant for ace");
      }
    } catch (error) {
      problem ??= `Turning Spade on failed: ${words(error)}`;
    } finally {
      if (problem) deps.log("warn", problem);
      link.setSwitch({ problem });
    }
    const ready = link.ready();
    if (made && ready) await deps.delivery.deliver(ready.connection, true);
  }

  async function off(cause: SpadeSwitchCause): Promise<void> {
    const { service, link, grants } = deps;
    const connection = link.ready()?.connection;
    const retired = grants.retireAll(deps.now());
    deps.endLease();
    if (retired.length) await deps.delivery.withdraw(connection);
    link.setEnabled(false);
    link.setSwitch({});
    try {
      if ((await service.state()) !== "absent") await service.remove();
    } catch (error) {
      // At start this is only a check: a build without the service manager has nothing to remove.
      if (cause === "changed") deps.log("warn", `Removing Spade's service failed: ${words(error)}`);
    }
  }

  return {
    /** Applies the setting; resolves once this and every earlier change are done. */
    set(enabled: boolean, cause: SpadeSwitchCause): Promise<void> {
      queue = queue
        .then(() => (enabled ? on(cause) : off(cause)))
        .catch((error: unknown) =>
          deps.log("warn", `Turning Spade ${enabled ? "on" : "off"} failed: ${words(error)}`),
        );
      return queue;
    },
  };
}
