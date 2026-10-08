import {
  ScreenGrant,
  type ScreenAgentScope,
  type ScreenError,
  type ThreadView,
} from "@ace/protocol";
import { browserApp, sensitiveApp } from "@ace/screen/sensitive-app";

export class FakeScreenError extends Error {
  readonly code: ScreenError["code"];
  readonly holder: { sessionId: string; owner: string } | undefined;
  constructor(
    code: ScreenError["code"],
    message: string,
    holder?: { sessionId: string; owner: string },
  ) {
    super(message);
    this.code = code;
    this.holder = holder;
  }
}
/** Scoped grants, with turn lifetime derived from the fake thread's actual root runs. */
export class FakeScreenAccess {
  enabled = false;
  private readonly grants = new Map<string, ScreenGrant>();
  private readonly now: () => number;
  private readonly thread: (id: string) => ThreadView | undefined;
  constructor(now: () => number, thread: (id: string) => ThreadView | undefined) {
    this.now = now;
    this.thread = thread;
  }
  turn(threadId: string): string | undefined {
    const view = this.thread(threadId);
    return (
      view &&
      Object.values(view.runs).find(
        (run) => run.agentId === view.thread.rootAgentId && run.state === "active",
      )?.id
    );
  }
  list(threadId?: string): ScreenGrant[] {
    return [...this.grants.values()]
      .filter(
        (grant) =>
          (!threadId || !grant.threadId || grant.threadId === threadId) &&
          (grant.scope !== "turn" ||
            (grant.threadId && grant.turnId === this.turn(grant.threadId))),
      )
      .map((grant) => ScreenGrant.parse(grant));
  }
  approve(
    bundleId: string,
    allowed: boolean,
    scope: ScreenGrant["scope"] = "always",
    threadId?: string,
  ): void {
    if (allowed && scope === "always" && browserApp(bundleId))
      throw new FakeScreenError(
        "approval_required",
        "Web browsers require a turn or thread grant from the person in ace's UI",
      );
    const thread = scope === "always" ? undefined : threadId;
    if (scope !== "always" && (!thread || !this.thread(thread)))
      throw new FakeScreenError("approval_required", "Screen approval thread unavailable");
    const key = `${bundleId}:${scope}:${thread ?? ""}`;
    if (!allowed) {
      this.grants.delete(key);
      return;
    }
    if (this.grants.size >= 256 && !this.grants.has(key))
      throw new FakeScreenError("busy", "Screen approval limit");
    const turnId = scope === "turn" && thread ? this.turn(thread) : undefined;
    if (scope === "turn" && !turnId)
      throw new FakeScreenError(
        "approval_required",
        "Screen turn approval requires an active root turn",
      );
    this.grants.set(
      key,
      ScreenGrant.parse({ bundleId, scope, threadId: thread, turnId, grantedAt: this.now() }),
    );
  }
  allows(bundleId: string, caller?: ScreenAgentScope): boolean {
    if (
      caller &&
      (!this.thread(caller.threadId) ||
        this.thread(caller.threadId)?.thread.deletedAt !== undefined)
    )
      return false;
    return this.list(caller?.threadId).some(
      (grant) =>
        grant.bundleId === bundleId &&
        (caller && sensitiveApp(bundleId)
          ? grant.scope === "turn" && grant.threadId === caller.threadId
          : (grant.scope === "always" && !browserApp(bundleId)) ||
            (caller && grant.threadId === caller.threadId)),
    );
  }
  require(bundleId: string, caller?: ScreenAgentScope): void {
    if (!this.enabled) throw new FakeScreenError("screen_disabled", "Screen access is disabled");
    if (caller && this.thread(caller.threadId)?.thread.permission?.effective === "read-only")
      throw new FakeScreenError("read_only", "Read-only mode refuses computer use");
    if (!this.allows(bundleId, caller))
      throw new FakeScreenError("approval_required", "Application approval required");
  }
}
