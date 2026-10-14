import type { ScreenTarget } from "@ace/protocol";
import type { ScreenAccess } from "./access.ts";
import { HelperCommandError } from "./helper.ts";
import type { HelperHost } from "./helper-host.ts";
import type { AppLaunches } from "./app-launches.ts";
import type { ScreenPolicy } from "./policy.ts";
import type { Session } from "./session.ts";
import { shutdownFailure } from "./shutdown-failure.ts";
type AccessPorts = {
  sessions: Map<string, Session>;
  policy: ScreenPolicy;
  host: HelperHost;
  launches: AppLaunches;
  stop(id: string): Promise<void>;
  hostClosed(): Promise<void>;
  resumeAgents(): void;
  enabledChanged(enabled: boolean): void;
};
/**
 * Computer use on or off: the person's switch in Settings. Turning it off ends every capture.
 * There are no per-app grants; an agent's calls are governed by its provider's permission mode.
 */
export class ScreenAccessPolicy {
  access: ScreenAccess | undefined;
  private readonly ports: AccessPorts;
  constructor(ports: AccessPorts) {
    this.ports = ports;
  }
  async enable(enabled: boolean): Promise<void> {
    const { policy, launches } = this.ports;
    if (!enabled) launches.invalidate();
    if (enabled) this.ports.resumeAgents();
    this.access?.enable(enabled);
    const changed = policy.enabled !== enabled;
    policy.enable(enabled);
    if (changed) this.ports.enabledChanged(enabled);
    if (!enabled) await this.disableCaptures();
  }
  private async disableCaptures(): Promise<void> {
    const sessions = [...this.ports.sessions.values()];
    const stops = sessions.map((session) => ({
      session,
      result: this.ports.stop(session.state.sessionId),
    }));
    const results = Promise.allSettled(stops.map((stop) => stop.result));
    // Publication can outlive capture; a rejected stop can never confirm capture.
    await Promise.all(
      stops.map(({ session, result }) =>
        Promise.race([session.captureStopped.promise, result.catch(() => {})]),
      ),
    );
    await this.ports.launches.drain();
    await this.ports.host.close();
    await this.ports.hostClosed();
    const errors = (await results).flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw shutdownFailure(errors, sessions.length);
  }
  configureAccess(access: ScreenAccess): void {
    this.access = access;
    this.ports.policy.enable(access.enabled());
  }
  /**
   * Simulator windows are device views, owned by the Devices switch; every other target needs
   * computer use on.
   */
  authorize(target: ScreenTarget): void {
    if (target.kind === "window" && target.bundleId === "com.apple.iphonesimulator") return;
    if (!this.ports.policy.enabled)
      throw new HelperCommandError("screen_disabled", "Screen access is disabled");
  }
}
