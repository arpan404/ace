import { ScreenBundle, ScreenAgentScope, type ScreenTarget } from "@ace/protocol";
import type { ScreenAccess } from "./access.ts";
import { HelperCommandError } from "./helper.ts";
import type { HelperHost } from "./helper-host.ts";
import type { AppLaunches } from "./app-launches.ts";
import { ScreenPolicy, bundles } from "./policy.ts";
import type { Session } from "./session.ts";
type AccessPorts = {
  sessions: Map<string, Session>;
  policy: ScreenPolicy;
  host: HelperHost;
  launches: AppLaunches;
  stop(id: string): Promise<void>;
  revalidate(): Promise<void>;
  resumeAgents(): void;
  enabledChanged(enabled: boolean): void;
};
/** Human grants and enablement. Capture and action lifetimes are delegated through ports. */
export class ScreenAccessPolicy {
  access: ScreenAccess | undefined;
  private readonly sessions: Map<string, Session>;
  private readonly policy: ScreenPolicy;
  private readonly host: HelperHost;
  private readonly launches: AppLaunches;
  private readonly stop: AccessPorts["stop"];
  private readonly revalidate: AccessPorts["revalidate"];
  private readonly resumeAgents: () => void;
  private readonly enabledChanged: (enabled: boolean) => void;
  constructor(ports: AccessPorts) {
    this.sessions = ports.sessions;
    this.policy = ports.policy;
    this.host = ports.host;
    this.launches = ports.launches;
    this.stop = ports.stop;
    this.revalidate = ports.revalidate;
    this.resumeAgents = ports.resumeAgents;
    this.enabledChanged = ports.enabledChanged;
  }
  async enable(enabled: boolean): Promise<void> {
    if (!enabled) this.launches.invalidate();
    if (enabled) this.resumeAgents();
    this.access?.enable(enabled);
    const changed = this.policy.enabled !== enabled;
    this.policy.enable(enabled);
    if (changed) this.enabledChanged(enabled);
    if (!enabled) {
      const sessions = [...this.sessions.values()];
      const results = Promise.allSettled(
        sessions.map((session) => this.stop(session.state.sessionId)),
      );
      await Promise.all(sessions.map((session) => session.captureStopped.promise));
      await this.launches.drain();
      await this.host.close();
      const errors = (await results).flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Screen shutdown failed");
    }
  }
  async approve(
    bundleId: string,
    allowed: boolean,
    scope: import("@ace/protocol").ScreenGrant["scope"] = "always",
    threadId?: string,
  ): Promise<void> {
    ScreenBundle.parse(bundleId);
    if (!allowed) this.launches.invalidate();
    this.access?.approve(bundleId, allowed, scope, threadId);
    if (!this.access || scope === "always") this.policy.approve(bundleId, allowed);
    if (!allowed && this.access) {
      await this.revalidate();
      await this.launches.drain();
      return;
    }
    if (!allowed) {
      await this.launches.drain();
      await Promise.all(
        [...this.sessions.values()]
          .filter((session) => bundles(session.state.target).includes(bundleId))
          .map((session) => this.stop(session.state.sessionId)),
      );
    }
  }
  /**
   * A person on this machine asked to see this app: turn screen access on and approve it. An
   * existing approval is left alone, so a capture already starting is not cancelled.
   */
  async allow(bundleId: string): Promise<void> {
    ScreenBundle.parse(bundleId);
    if (!this.policy.enabled) await this.enable(true);
    try {
      this.requireApproval(bundleId);
    } catch {
      await this.approve(bundleId, true);
    }
  }
  requireApproval(bundleId: string): void {
    this.authorize({ kind: "window", bundleId: ScreenBundle.parse(bundleId), windowId: 1 });
  }
  configureAccess(access: ScreenAccess): void {
    this.access = access;
    this.policy.enable(access.enabled());
  }
  approvals(threadId?: string) {
    return (
      this.access?.list(threadId) ??
      this.policy
        .allowlist()
        .map((bundleId) => ({ bundleId, scope: "always" as const, grantedAt: 0 }))
    );
  }
  private allowlist(): string[] {
    return this.policy.allowlist();
  }
  authorize(target: ScreenTarget, scope?: ScreenAgentScope): void {
    if (!this.policy.enabled)
      throw new HelperCommandError("screen_disabled", "Screen access is disabled");
    if (
      !bundles(target).every((bundle) =>
        this.access ? this.access.allows(bundle, scope) : this.allowlist().includes(bundle),
      )
    )
      throw new HelperCommandError("approval_required", "Application approval required");
  }
  async requestApp(
    bundleId: string,
    reason: string,
    caller: ScreenAgentScope,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.policy.enabled)
      throw new HelperCommandError("screen_disabled", "Screen access is disabled");
    if (!this.access)
      throw new HelperCommandError("approval_required", "Host approval unavailable");
    await this.access.request(
      ScreenBundle.parse(bundleId),
      reason,
      ScreenAgentScope.parse(caller),
      signal,
    );
  }
}
