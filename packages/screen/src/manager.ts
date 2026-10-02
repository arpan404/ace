import {
  ScreenAction,
  ScreenAgentScope,
  type ScreenCapabilities,
  ScreenBundle,
  ScreenInventory,
  ScreenPermissions,
  ScreenTarget,
  type ScreenState,
} from "@ace/protocol";
import { type Frame, type FrameSink } from "./frames.ts";
import { type Helper, type HelperOptions } from "./helper.ts";
import { HelperOwner } from "./helper-owner.ts";
import { captureSession, sessionFrames } from "./session-capture.ts";
import { type Session, captureDemand, freshScreenshot, endSnapshot } from "./session.ts";
import { SessionUI } from "./session-ui.ts";
import type { RecordingArtifact } from "./recording.ts";
import { startRecording, stopRecording } from "./session-recording.ts";
import { stopCaptureSession } from "./session-stop.ts";
import { agentOwner } from "./agent-binding.ts";
import { systemScheduler, type Scheduler } from "./runtime.ts";

export type ScreenOptions = Omit<HelperOptions, "onFrame" | "onFailure"> & {
  scheduler?: Scheduler;
  recordingLimitBytes?: number;
  recordingDirectory: string;
  publishArtifact: (artifact: RecordingArtifact) => Promise<void>;
};
export class ScreenManager {
  private enabled = false;
  private readonly allowed = new Set<string>();
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(state: ScreenState) => void>();
  private readonly options: ScreenOptions;
  private reservations = 0;
  private policyEpoch = 0;
  private readonly helpers: HelperOwner;
  private readonly ui: SessionUI;
  private get persistent(): boolean {
    return this.helpers.persistent;
  }
  private demand(session: Session): void {
    captureDemand(
      session,
      this.persistent,
      (error) => this.fail(session, error),
      this.helpers.nextGeneration,
    );
  }
  capabilities(id: string): ScreenCapabilities | undefined {
    return this.live(id).helper.capabilities;
  }
  constructor(options: ScreenOptions) {
    this.options = options;
    this.helpers = new HelperOwner(options);
    this.ui = new SessionUI(
      (id, owner) => {
        const session = this.live(id);
        this.authorize(session.state.target);
        if (session.owner !== owner) throw new Error("Controller ownership required");
        return session;
      },
      (id, actor, owner, command) => this.controlled(id, actor, owner, command),
    );
  }
  async enable(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    this.policyEpoch++;
    if (!enabled) {
      const stopped = await Promise.allSettled(
        [...this.sessions.keys()].map((id) => this.stop(id)),
      );
      const errors = stopped
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "Screen shutdown failed");
    }
  }
  async approve(bundleId: string, allowed: boolean): Promise<void> {
    ScreenBundle.parse(bundleId);
    this.policyEpoch++;
    if (allowed) {
      if (this.allowed.size >= 64 && !this.allowed.has(bundleId)) throw new Error("Approval limit");
      this.allowed.add(bundleId);
    } else {
      this.allowed.delete(bundleId);
      await Promise.all(
        [...this.sessions.values()]
          .filter((session) => bundles(session.state.target).includes(bundleId))
          .map((session) => this.stop(session.state.sessionId)),
      );
    }
  }
  requireApproval(bundleId: string): void {
    this.authorizeApplications([ScreenBundle.parse(bundleId)]);
  }
  private authorize(target: ScreenTarget): void {
    this.authorizeApplications(bundles(target));
  }
  private authorizeApplications(bundleIds: string[]): void {
    if (!this.enabled) throw new Error("Screen access is disabled");
    if (!bundleIds.every((bundle) => this.allowed.has(bundle)))
      throw new Error("Application approval required");
  }
  private async inspect(op: "permissions" | "targets"): Promise<unknown> {
    if (this.reservations >= 4) throw new Error("Helper inspection limit");
    this.reservations++;
    let helper: Helper | undefined;
    try {
      helper = await this.helpers.open();
      return await helper.request({ op });
    } finally {
      this.reservations--;
      if (helper) await this.helpers.release(helper);
    }
  }
  async permissions(): Promise<ScreenPermissions> {
    return ScreenPermissions.parse(await this.inspect("permissions"));
  }
  async targets(): Promise<ScreenInventory> {
    if (!this.enabled) throw new Error("Screen access is disabled");
    return ScreenInventory.parse(await this.inspect("targets"));
  }
  async start(input: ScreenTarget, fps = 10): Promise<ScreenState> {
    const target = ScreenTarget.parse(input);
    this.authorize(target);
    if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw new Error("Invalid frame rate");
    if (this.sessions.size + this.reservations >= (this.persistent ? 1 : 4))
      throw new Error("Session limit");
    this.reservations++;
    const epoch = this.policyEpoch;
    let helper: Helper | undefined;
    let session: Session | undefined;
    try {
      const id = this.options.nextId();
      if (this.sessions.has(id)) throw new Error("Duplicate session id");
      helper = await this.helpers.open({
        onFrame: sessionFrames(
          () => session,
          this.persistent,
          () => this.authorize(target),
          (current, error) => this.fail(current, error),
          (current) => this.demand(current),
        ),
        onFailure: (error) => {
          if (session) this.fail(session, error);
        },
      });
      session = captureSession(helper, id, target, this.helpers.nextGeneration());
      this.sessions.set(id, session);
      session.state.permissions = ScreenPermissions.parse(
        await helper.request({ op: "permissions" }),
      );
      if (!session.state.permissions.screenRecording)
        throw new Error("Screen Recording permission denied");
      this.authorize(target);
      if (epoch !== this.policyEpoch) throw new Error("Screen policy changed during start");
      if (
        helper.capabilities &&
        !(target.kind === "display"
          ? helper.capabilities.capture.displays
          : helper.capabilities.capture.windows)
      )
        throw new Error("Helper does not support target capture");
      const command = {
        op: "start" as const,
        sessionId: id,
        target,
        fps,
        allowlist: [...this.allowed],
      };
      if (this.persistent)
        await helper.requestV2({ ...command, captureGeneration: session.captureGeneration });
      else await helper.request(command);
      this.authorize(target);
      if (epoch !== this.policyEpoch || session.state.lifecycle !== "starting")
        throw new Error("Screen start cancelled");
      session.state = { ...session.state, lifecycle: "live", indicator: true };
      this.emit(session);
      if (session.latest) this.demand(session);
      return this.state(id);
    } catch (error) {
      if (session) {
        this.fail(session, error instanceof Error ? error : new Error("Start failed"));
        this.sessions.delete(session.state.sessionId);
      }
      if (helper) await this.helpers.stop(helper);
      throw error;
    } finally {
      this.reservations--;
    }
  }
  states(): ScreenState[] {
    return [...this.sessions.values()].map((session) => structuredClone(session.state));
  }
  state(id: string): ScreenState {
    return structuredClone(this.get(id).state);
  }
  watch(listener: (state: ScreenState) => void): () => void {
    if (this.listeners.size >= 64) throw new Error("State subscriber limit");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribe(id: string, sink: FrameSink): () => void {
    const session = this.live(id);
    const stop = session.hub.subscribe(sink, session.latest, () => {
      session.viewers--;
      this.demand(session);
    });
    session.viewers++;
    this.demand(session);
    return stop;
  }
  screenshot(id: string): Frame {
    const session = this.live(id);
    this.authorize(session.state.target);
    if (!session.latest) throw new Error("No captured frame yet");
    return session.latest;
  }
  async screenshotFresh(id: string): Promise<Frame> {
    const session = this.live(id);
    this.authorize(session.state.target);
    if (this.persistent) await session.helper.request({ op: "permissions" });
    return freshScreenshot(
      session,
      this.persistent,
      this.options.timeoutMs ?? 10_000,
      () => this.demand(session),
      this.options.scheduler ?? systemScheduler,
    );
  }
  controller(id: string, controller: ScreenState["controller"], owner = "local"): void {
    const session = this.live(id);
    session.epoch++;
    session.owner = controller === "none" ? undefined : owner;
    session.state = { ...session.state, controller };
    this.emit(session);
  }
  delegateAgent(id: string, input: ScreenAgentScope): void {
    this.controller(id, "agent", agentOwner(input));
  }
  agentSession(input: ScreenAgentScope): string {
    const owner = agentOwner(input);
    const matches = [...this.sessions.values()].filter(
      (session) =>
        session.state.lifecycle === "live" &&
        session.state.controller === "agent" &&
        session.owner === owner,
    );
    if (matches.length !== 1 || !matches[0])
      throw new Error("A single delegated screen session is required");
    this.authorize(matches[0].state.target);
    return matches[0].state.sessionId;
  }
  async action(
    id: string,
    actor: "human" | "agent",
    input: ScreenAction,
    owner = "local",
  ): Promise<void> {
    const action = ScreenAction.parse(input);
    const capabilities = this.live(id).helper.capabilities;
    const inputKind =
      action.kind === "click"
        ? "pointer"
        : action.kind === "type"
          ? "text"
          : action.kind === "key"
            ? "keyboard"
            : "scroll";
    if (capabilities && !capabilities.input[inputKind])
      throw new Error("Helper input not supported");
    await this.controlled(id, actor, owner, (helper) => helper.request({ op: "action", action }));
  }
  private async controlled<T>(
    id: string,
    actor: "human" | "agent",
    owner: string,
    command: (helper: Helper) => Promise<T>,
  ): Promise<T> {
    const session = this.live(id);
    this.authorize(session.state.target);
    if (session.state.target.kind === "display") throw new Error("Display capture is view-only");
    if (session.state.controller !== actor || session.owner !== owner)
      throw new Error("Controller ownership required");
    if (session.queuedActions >= 16) throw new Error("Input queue limit");
    session.queuedActions++;
    this.demand(session);
    const epoch = session.epoch;
    const execute = session.actionTail
      .then(async () => {
        if (session.epoch !== epoch) throw new Error("Controller changed");
        const permissions = ScreenPermissions.parse(
          await session.helper.request({ op: "permissions" }),
        );
        session.state.permissions = permissions;
        this.emit(session);
        if (!permissions.screenRecording)
          this.fail(session, new Error("Screen Recording permission revoked"));
        if (!permissions.accessibility || !permissions.screenRecording)
          throw new Error("Input permission denied");
        this.authorize(session.state.target);
        if (
          session.epoch !== epoch ||
          session.state.controller !== actor ||
          session.state.lifecycle !== "live"
        )
          throw new Error("Controller changed");
        return command(session.helper);
      })
      .finally(() => {
        session.queuedActions--;
        this.demand(session);
      });
    session.actionTail = execute.catch(() => {});
    return execute;
  }
  uiTree(id: string, options: unknown, owner: string): Promise<unknown> {
    return this.ui.tree(id, options, owner);
  }
  uiFind(id: string, options: unknown, owner: string): Promise<unknown> {
    return this.ui.find(id, options, owner);
  }
  uiAct(
    id: string,
    options: unknown,
    owner: string,
    actor: "human" | "agent" = "agent",
  ): Promise<unknown> {
    return this.ui.act(id, options, owner, actor);
  }
  keyPress(
    id: string,
    key: string,
    modifiers: ("control" | "shift" | "alt" | "meta")[],
    owner: string,
  ): Promise<void> {
    return this.ui.key(id, key, modifiers, owner);
  }
  releaseController(owner: string): void {
    for (const session of this.sessions.values())
      if (session.owner === owner && session.state.lifecycle === "live")
        this.controller(session.state.sessionId, "none");
  }
  startRecording(id: string): Promise<void> {
    const session = this.live(id);
    return startRecording(session, this.options, () => this.demand(session));
  }
  stopRecording(id: string): Promise<RecordingArtifact> {
    return stopRecording(this.get(id));
  }
  stop(id: string): Promise<void> {
    const session = this.get(id);
    session.stopping ??= this.stopSession(session);
    return session.stopping;
  }
  private async stopSession(session: Session): Promise<void> {
    const failed = session.state.lifecycle === "failed";
    try {
      await stopCaptureSession(
        session,
        () => (failed ? session.helper.close() : this.helpers.stop(session.helper)),
        () => this.emit(session),
      );
    } finally {
      this.sessions.delete(session.state.sessionId);
    }
  }
  async close(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.enable(false);
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await this.helpers.close();
      } catch (error) {
        errors.push(error);
      } finally {
        this.listeners.clear();
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Screen close failed");
  }
  private get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown screen session");
    return session;
  }
  private live(id: string): Session {
    const session = this.get(id);
    if (session.state.lifecycle !== "live") throw new Error("Screen session is not live");
    return session;
  }
  private emit(session: Session): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state(session.state.sessionId));
      } catch {
        /* An observer cannot change session safety. */
      }
    }
  }
  private fail(session: Session, error: Error): void {
    if (session.state.lifecycle === "failed" || session.state.lifecycle === "stopped") return;
    session.epoch++;
    session.latest = undefined;
    endSnapshot(session);
    session.hub.clear();
    session.state = {
      ...session.state,
      lifecycle: "failed",
      indicator: false,
      controller: "none",
      error: error.message.slice(0, 1024),
    };
    this.emit(session);
    void session.recording?.stop().catch(() => {});
    session.recording = undefined;
    void this.helpers.stop(session.helper).catch(() => {});
  }
}
function bundles(target: ScreenTarget): string[] {
  return target.kind === "display" ? target.bundleIds : [target.bundleId];
}
