import {
  ScreenClientMessage,
  ScreenState,
  ScreenPermissions,
  ScreenInventory,
  type ScreenServerMessage,
  type ScreenOperation,
  type ScreenAgentScope,
  type ScreenError,
} from "@ace/protocol";
import type { ScreenTransport } from "@ace/client/screen-stream";
import type { FakeServiceContext } from "./service-context.ts";
import { FakeScreenAccess, FakeScreenError } from "./screen-access.ts";
import { FakeScreenApprovals } from "./screen-approvals.ts";
import { fakeScreenFrame } from "./screen-frame.ts";

type Channel = {
  send(message: ScreenServerMessage | Uint8Array): void;
  subscriptions: Set<string>;
};
type Session = {
  state: ScreenState;
  scope?: ScreenAgentScope | undefined;
  owner?: Channel | undefined;
  modeApproval?: AbortController | undefined;
};
export interface FakeScreenOptions {
  host: FakeServiceContext;
  id(): string;
  schedule(callback: () => void, delay: number): () => void;
  permissions?: ScreenPermissions;
}
/** Fake desktop targets share the real wire states, scopes, approvals and frame format. */
export class FakeScreen {
  readonly permissions: ScreenPermissions;
  /**
   * Set to make reading macOS's grants fail the way a real helper can (not running, timing
   * out): `status` and `permissions` are refused with it until it is cleared.
   */
  permissionReadFailure: { code: ScreenError["code"]; message: string } | undefined;
  /**
   * Set to hold Stop all until `until` settles and then, with `failure`, refuse it the way the
   * daemon does when a helper session won't stop. Every session still stops here.
   */
  stopAllHold: { until: Promise<void>; failure?: string } | undefined;
  readonly requested: ("screenRecording" | "accessibility")[] = [];
  readonly access: FakeScreenAccess;
  readonly approvals: FakeScreenApprovals;
  private readonly options: FakeScreenOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly channels = new Set<Channel>();
  private sequence = 0;
  constructor(options: FakeScreenOptions) {
    this.options = options;
    this.permissions = options.permissions ?? { screenRecording: true, accessibility: true };
    this.access = new FakeScreenAccess(options.host.now, options.host.thread);
    this.approvals = new FakeScreenApprovals({ ...options, access: this.access });
  }
  revalidate(): void {
    for (const session of this.sessions.values()) {
      try {
        for (const bundle of this.bundles(session.state))
          this.access.require(bundle, session.scope);
      } catch {
        this.stop(session);
      }
    }
  }
  requestApp(
    bundleId: string,
    reason: string,
    caller: ScreenAgentScope,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.approvals
      .requestApp(bundleId, reason, caller, signal)
      .finally(() => this.revalidate());
  }
  /** Main socket controls and dedicated frame sockets see the same shared world. */
  connection(send: Channel["send"]): {
    request(raw: unknown, human?: boolean): Promise<void>;
    close(): void;
  } {
    const channel: Channel = { send, subscriptions: new Set() };
    this.channels.add(channel);
    return {
      request: async (raw, human = true) => {
        const message = ScreenClientMessage.parse(raw);
        if (!this.channels.has(channel)) return;
        let result: ScreenServerMessage;
        try {
          if (!human)
            throw new FakeScreenError("forbidden", "Admin scope required for screen access");
          const data = await this.operate(channel, message.operation);
          result = { type: "screen.result", requestId: message.requestId, ok: true, data };
        } catch (error) {
          result = {
            type: "screen.result",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : "Screen request failed",
            errorCode: error instanceof FakeScreenError ? error.code : "internal",
            ...(error instanceof FakeScreenError && error.holder ? { holder: error.holder } : {}),
          };
        }
        if (this.channels.has(channel)) send(result);
      },
      close: () => {
        this.channels.delete(channel);
        for (const session of this.sessions.values())
          if (session.owner === channel) this.controller(session, "none");
      },
    };
  }
  transport(): ScreenTransport {
    let connection: ReturnType<FakeScreen["connection"]> | undefined;
    let epoch = 0;
    return {
      open: (events) => {
        const stamp = ++epoch;
        connection = this.connection((message) => {
          if (epoch === stamp) events.message(message);
        });
        queueMicrotask(() => {
          if (epoch === stamp) events.ready();
        });
      },
      send: (message) => {
        if (!connection) throw new Error("Screen channel is not authenticated");
        return connection.request(message);
      },
      close: () => {
        epoch++;
        connection?.close();
        connection = undefined;
      },
    };
  }
  private push(message: ScreenServerMessage): void {
    for (const channel of this.channels) channel.send(message);
  }
  private publish(session: Session): ScreenState {
    const state = ScreenState.parse(session.state);
    this.push({ type: "screen.state", state });
    return state;
  }
  private paint(session: Session, only?: Channel): void {
    const viewers = only
      ? [only]
      : [...this.channels].filter((channel) => channel.subscriptions.has(session.state.sessionId));
    if (session.state.lifecycle !== "live" || !viewers.length) return;
    const packet = fakeScreenFrame({
      sessionId: session.state.sessionId,
      sequence: ++this.sequence,
      timestamp: this.options.host.now(),
      screen: "app",
    });
    for (const channel of viewers) if (this.channels.has(channel)) channel.send(packet);
  }
  private live(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new FakeScreenError("target_gone", "Screen session unavailable");
    return session;
  }
  private bundles(state: ScreenState): string[] {
    return state.target.kind === "display" ? state.target.bundleIds : [state.target.bundleId];
  }
  private controller(
    session: Session,
    controller: ScreenState["controller"],
    holder?: ScreenAgentScope,
    owner?: Channel,
  ): ScreenState {
    session.modeApproval?.abort(
      new FakeScreenError("denied", "Controller changed during approval"),
    );
    session.owner = controller === "human" ? owner : undefined;
    session.scope = holder ?? session.scope;
    session.state = {
      ...session.state,
      controller,
      holder: controller === "agent" ? holder : undefined,
      mode: "background",
      secureInputAllowed: false,
      indicator: controller === "agent",
    };
    return this.publish(session);
  }
  private stop(session: Session): void {
    if (!this.sessions.delete(session.state.sessionId)) return;
    this.controller(session, "none");
    session.state.lifecycle = "stopped";
    this.publish(session);
    for (const channel of this.channels) channel.subscriptions.delete(session.state.sessionId);
  }
  enable(enabled: boolean): void {
    const changed = this.access.enabled !== enabled;
    this.access.enabled = enabled;
    if (changed) this.push({ type: "screen.enabled", enabled });
    if (!enabled) for (const session of this.sessions.values()) this.stop(session);
  }
  private readablePermissions(): void {
    const failure = this.permissionReadFailure;
    if (failure) throw new FakeScreenError(failure.code, failure.message);
  }
  private async operate(channel: Channel, op: ScreenOperation): Promise<unknown> {
    switch (op.op) {
      case "enable":
        this.enable(op.enabled);
        return;
      case "status":
        this.readablePermissions();
        return {
          enabled: this.access.enabled,
          permissions: { ...this.permissions },
          sessions: this.sessions.size,
        };
      case "permissions":
        this.readablePermissions();
        return { ...this.permissions };
      case "permissions.request":
        this.requested.push(op.permission);
        return { ...this.permissions };
      case "approve": {
        this.access.approve(op.bundleId, op.allowed, op.scope, op.threadId);
        if (!op.allowed)
          for (const session of this.sessions.values())
            if (
              this.bundles(session.state).some(
                (bundle) => !this.access.allows(bundle, session.scope),
              )
            )
              this.stop(session);
        return;
      }
      case "approvals":
        return this.access.list(op.threadId);
      case "sessions":
        return [...this.sessions.values()].map((session) => ScreenState.parse(session.state));
      case "stop.all": {
        const hold = this.stopAllHold;
        await hold?.until;
        this.enable(false);
        if (hold?.failure) throw new FakeScreenError("internal", hold.failure);
        return;
      }
      case "targets":
        return ScreenInventory.parse({
          displays: [],
          windows: [
            { bundleId: "com.apple.TextEdit", windowId: 1, title: "Untitled" },
            { bundleId: "com.apple.Safari", windowId: 4, title: "Browser settings" },
            { bundleId: "com.apple.calculator", windowId: 2, title: "Calculator" },
            { bundleId: "com.apple.iphonesimulator", windowId: 3, title: "iPhone Simulator" },
          ],
        });
      case "open.app":
        this.access.require(op.bundleId);
        return { bundleId: op.bundleId, pid: 101, mode: "background" };
      case "start": {
        const scope = op.threadId ? { threadId: op.threadId, agentId: "human" } : undefined;
        const bundles = op.target.kind === "display" ? op.target.bundleIds : [op.target.bundleId];
        for (const bundle of bundles) this.access.require(bundle, scope);
        if (!this.permissions.screenRecording)
          throw new FakeScreenError("permission_denied", "Screen Recording permission required");
        for (const session of this.sessions.values())
          if (this.bundles(session.state).some((bundle) => bundles.includes(bundle)))
            throw new FakeScreenError(
              "target_busy",
              `Target held by ${session.state.holder?.agentId ?? session.state.controller}`,
              {
                sessionId: session.state.sessionId,
                owner: session.state.holder
                  ? `${session.state.holder.threadId}:${session.state.holder.agentId}`
                  : session.state.controller,
              },
            );
        if (this.sessions.size >= 8) throw new FakeScreenError("busy", "Screen target limit (8)");
        const session: Session = {
          scope,
          state: ScreenState.parse({
            sessionId: this.options.id(),
            lifecycle: "live",
            controller: "none",
            mode: "background",
            indicator: false,
            target: op.target,
            permissions: { ...this.permissions },
          }),
        };
        this.sessions.set(session.state.sessionId, session);
        return this.publish(session);
      }
      case "simulators":
        return [];
      case "simulator.boot":
        this.access.require("com.apple.iphonesimulator");
        return;
      case "capabilities":
        throw new FakeScreenError("not_supported", "Native capabilities unavailable in fake mode");
    }
    const session = this.live(op.sessionId);
    if (op.op === "stop") {
      this.stop(session);
      return;
    }
    if (op.op === "unsubscribe") {
      channel.subscriptions.delete(op.sessionId);
      return;
    }
    if (op.op === "controller" && op.controller === "none") return this.controller(session, "none");
    for (const bundle of this.bundles(session.state)) this.access.require(bundle, session.scope);
    switch (op.op) {
      case "controller": {
        if (op.controller === "agent") {
          if (!op.threadId || !op.agentId)
            throw new FakeScreenError("denied", "Agent id and thread required");
          const holder = { threadId: op.threadId, agentId: op.agentId };
          for (const bundle of this.bundles(session.state)) this.access.require(bundle, holder);
          if (
            session.state.controller === "agent" &&
            JSON.stringify(session.state.holder) !== JSON.stringify(holder)
          )
            throw new FakeScreenError(
              "target_busy",
              `Target held by ${session.state.holder?.agentId}`,
              {
                sessionId: session.state.sessionId,
                owner: session.state.holder?.agentId ?? "agent",
              },
            );
          return this.controller(session, "agent", holder);
        }
        return this.controller(session, "human", undefined, channel);
      }
      case "mode": {
        const before = session.state;
        session.modeApproval?.abort(new FakeScreenError("denied", "Mode changed during approval"));
        if (op.mode === "foreground") {
          const approval = new AbortController();
          session.modeApproval = approval;
          try {
            await this.approvals.foreground(before, op.reason, approval.signal);
          } finally {
            if (session.modeApproval === approval) session.modeApproval = undefined;
          }
        }
        if (!this.sessions.has(op.sessionId) || session.state !== before)
          throw new FakeScreenError("denied", "Controller changed during approval");
        session.state = { ...session.state, mode: op.mode };
        return this.publish(session);
      }
      case "secure.input":
        session.state = { ...session.state, secureInputAllowed: op.allowed };
        return this.publish(session);
      case "subscribe":
        channel.subscriptions.add(op.sessionId);
        channel.send({ type: "screen.state", state: ScreenState.parse(session.state) });
        this.paint(session, channel);
        return;
      case "action":
      case "input":
      case "ui.act":
        if (session.state.controller !== "human" || session.owner !== channel)
          throw new FakeScreenError("denied", "Controller lease required");
        if (!this.permissions.accessibility)
          throw new FakeScreenError("permission_denied", "Accessibility permission required");
        this.paint(session);
        return {
          mode: session.state.mode,
          snapshot: { nodes: [], truncated: false },
          fallback: false,
        };
      case "ui.tree":
      case "ui.find":
        return { nodes: [], truncated: false };
      default:
        throw new FakeScreenError("not_supported", "Recording unavailable in fake mode");
    }
  }
}
