import { releaseControllerBinding } from "./controller-binding.ts";
import {
  ScreenTarget,
  ScreenCapabilities,
  type ScreenState,
  type ScreenAgentScope,
} from "@ace/protocol";
import { HelperCommandError, type Helper } from "./helper.ts";
import type { HelperHost } from "./helper-host.ts";
import { bundles, ScreenPolicy, stopping, terminated, replaceableSession } from "./policy.ts";
import { TargetBusyError } from "./target-busy.ts";
import { agentOwner } from "./agent-binding.ts";
import { createSession, type Session } from "./session.ts";
import { ScreenStopError } from "./stop-error.ts";
import { stopSessionRecording } from "./session-recording.ts";
import type { ScreenOptions } from "./options.ts";

type LifecyclePorts = {
  options: ScreenOptions;
  host: HelperHost;
  sessions: Map<string, Session>;
  policy: ScreenPolicy;
  authorize(target: ScreenTarget, scope?: ScreenAgentScope, humanView?: boolean): void;
  emit(session: Session): void;
  nextGeneration(): number;
};
/** Capture lifetime and app reservations; no approvals or action policy is owned here. */
export class TargetSessions {
  private readonly options: ScreenOptions;
  private readonly host: HelperHost;
  private readonly sessions: Map<string, Session>;
  private readonly policy: ScreenPolicy;
  private readonly authorize: LifecyclePorts["authorize"];
  private readonly emit: LifecyclePorts["emit"];
  private readonly nextGeneration: () => number;
  private starting = 0;
  private readonly pendingTargets = new Map<string, string>();
  private readonly pendingOwners = new Map<string, string>();
  private readonly starts = new Set<Promise<ScreenState>>();
  constructor(ports: LifecyclePorts) {
    this.options = ports.options;
    this.host = ports.host;
    this.sessions = ports.sessions;
    this.policy = ports.policy;
    this.authorize = ports.authorize;
    this.emit = ports.emit;
    this.nextGeneration = ports.nextGeneration;
  }
  get pendingCount(): number {
    return this.starting;
  }
  async drain(): Promise<void> {
    await Promise.allSettled(this.starts);
  }
  private state(id: string): ScreenState {
    return structuredClone(this.get(id).state);
  }
  private get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown screen session");
    return session;
  }
  start(input: ScreenTarget, fps = 10, scope?: ScreenAgentScope): Promise<ScreenState> {
    const task = this.startTarget(input, fps, scope);
    this.starts.add(task);
    return task.finally(() => this.starts.delete(task));
  }
  startHumanView(input: ScreenTarget, fps = 10): Promise<ScreenState> {
    const target = ScreenTarget.parse(input);
    if (target.kind !== "window" || target.bundleId !== "com.apple.iphonesimulator")
      throw new Error("Human device viewing requires a Simulator window");
    const task = this.startTarget(target, fps, undefined, true);
    this.starts.add(task);
    return task.finally(() => this.starts.delete(task));
  }
  private async startTarget(
    input: ScreenTarget,
    fps: number,
    scope?: ScreenAgentScope,
    humanView = false,
  ): Promise<ScreenState> {
    const target = ScreenTarget.parse(input);
    this.authorize(target, scope, humanView);
    if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error("Invalid frame rate");
    const selectedBundles = bundles(target);
    for (const bundle of selectedBundles) {
      let holder = [...this.sessions.values()].find((session) =>
        bundles(session.state.target).includes(bundle),
      );
      if (holder && replaceableSession(holder)) {
        await this.stop(holder.state.sessionId);
        holder = [...this.sessions.values()].find((session) =>
          bundles(session.state.target).includes(bundle),
        );
      }
      const pending = this.pendingTargets.get(bundle);
      if (holder || pending)
        throw new TargetBusyError(
          bundle,
          holder?.state.sessionId ?? pending ?? "starting",
          holder?.owner ??
            this.pendingOwners.get(pending ?? holder?.state.sessionId ?? "") ??
            holder?.state.controller ??
            "starting",
        );
    }
    if (new Set([...this.sessions.keys(), ...this.pendingTargets.values()]).size >= 8)
      throw new HelperCommandError("busy", "Session limit (8)");
    const id = this.options.nextId();
    if (this.sessions.has(id) || [...this.pendingTargets.values()].includes(id))
      throw new Error("Duplicate session id");
    for (const bundle of selectedBundles) this.pendingTargets.set(bundle, id);
    this.pendingOwners.set(id, scope ? agentOwner(scope) : "human");
    this.starting++;
    const epoch = this.policy.epoch;
    let helper: Helper | undefined;
    let session: Session | undefined;
    try {
      if (this.sessions.has(id)) throw new Error("Duplicate session id");
      helper = await this.host.open();
      if (
        helper.capabilities &&
        ((target.kind === "display" && !helper.capabilities.capture.displays) ||
          (target.kind !== "display" && !helper.capabilities.capture.windows))
      )
        throw new Error("Helper does not support capture target");
      if (!helper.capabilities?.background && this.sessions.size)
        throw new Error("Helper supports one session");
      session = createSession(
        helper,
        id,
        target,
        (active) => {
          const current = this.sessions.get(id);
          if (current && ["starting", "live"].includes(current.state.lifecycle)) {
            current.state = { ...current.state, indicator: active };
            this.emit(current);
          }
        },
        (error) => {
          const current = this.sessions.get(id);
          if (current) this.fail(current, error);
        },
        this.nextGeneration,
      );
      session.approvalScope = scope;
      session.humanView = humanView;
      this.sessions.set(id, session);
      session.state.permissions = await helper.permissions();
      if (!session.state.permissions.screenRecording)
        throw new HelperCommandError("permission_denied", "Screen Recording permission denied");
      this.authorize(target, scope, humanView);
      if (epoch !== this.policy.epoch) throw new Error("Screen policy changed during start");
      session.state = { ...session.state, indicator: helper.capabilities?.platform !== "macos" };
      this.emit(session);
      if (epoch !== this.policy.epoch || session.state.lifecycle !== "starting")
        throw new Error("Screen start cancelled");
      const start = {
        op: "start" as const,
        sessionId: id,
        target,
        fps: helper.capabilities?.platform === "macos" ? fps : Math.min(30, fps),
        capture: helper.capabilities?.platform !== "macos",
        allowlist: bundles(target),
      };
      const startingSession = session,
        startingHelper = helper;
      const validateStart = () => {
        this.authorize(target, scope, humanView);
        if (epoch !== this.policy.epoch || startingSession.state.lifecycle !== "starting")
          throw new Error("Screen start cancelled");
      };
      await this.host.execute(validateStart, async () => {
        startingSession.nativeStarted = true;
        if (startingHelper.capabilities?.platform === "windows") {
          await startingHelper.requestV2(
            {
              ...start,
              captureGeneration: startingSession.pixels.startGeneration(),
            },
            validateStart,
          );
          await startingSession.pixels.initialize();
        } else {
          const result = await startingHelper.request(start, validateStart);
          if (startingHelper.capabilities?.platform.startsWith("linux")) {
            if (!result || typeof result !== "object" || !("capabilities" in result))
              throw new Error("Missing capture capabilities");
            startingHelper.capabilities = ScreenCapabilities.parse(result.capabilities);
            startingSession.state.capabilities = startingHelper.capabilities;
          }
        }
      });
      this.authorize(target, scope, humanView);
      if (epoch !== this.policy.epoch || session.state.lifecycle !== "starting")
        throw new Error("Screen start cancelled");
      session.state = {
        ...session.state,
        lifecycle: "live",
      };
      this.emit(session);
      return this.state(id);
    } catch (error) {
      if (session) {
        this.fail(session, error instanceof Error ? error : new Error("Start failed"));
      }
      if (session?.failureCleanup) await session.failureCleanup;
      if (session?.stopping) await session.stopping;
      if (helper && this.sessions.size <= (session ? 1 : 0)) await this.host.close();
      if (session) {
        session.state = terminated(session.state);
        this.emit(session);
        this.sessions.delete(session.state.sessionId);
      }
      throw error;
    } finally {
      this.starting--;
      for (const bundle of selectedBundles) this.pendingTargets.delete(bundle);
      this.pendingOwners.delete(id);
    }
  }
  stop(id: string): Promise<void> {
    const session = this.get(id);
    if (!session.stopping) {
      const task = this.finish(session);
      session.stopping = task;
      void task.catch(() => {
        if (session.state.lifecycle === "stopping") session.stopping = undefined;
      });
    }
    return session.stopping;
  }
  private async finish(session: Session): Promise<void> {
    session.epoch++;
    session.latest = undefined;
    session.hub.clear();
    session.state = stopping(session.state);
    this.emit(session);
    session.pixels.stop();
    const errors: unknown[] = [];
    const releaseError = releaseControllerBinding(session);
    if (releaseError) errors.push(releaseError);
    let captureTerminated = false;
    try {
      if (session.failureCleanup) await session.failureCleanup;
      else await this.host.stopCapture(session.helper);
      captureTerminated = true;
    } catch (error) {
      captureTerminated = error instanceof ScreenStopError && error.captureTerminated;
      errors.push(error);
    }
    if (!captureTerminated) {
      session.state = { ...session.state, error: "Capture termination could not be confirmed" };
      this.emit(session);
      throw new ScreenStopError(errors, false);
    }
    try {
      await this.retire(session);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new ScreenStopError(errors, captureTerminated);
  }
  /** Only called after the shared process has been confirmed closed. */
  async hostClosed(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.sessions.values()].map(async (session) => {
        session.epoch++;
        session.latest = undefined;
        session.hub.clear();
        session.pixels.stop();
        const error = releaseControllerBinding(session);
        await this.retire(session);
        if (error) throw error;
      }),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new ScreenStopError(errors, true);
  }
  private async retire(session: Session): Promise<void> {
    session.captureStopped.resolve();
    session.state = terminated(session.state);
    this.emit(session);
    try {
      if (session.recording || session.completedRecording) await stopSessionRecording(session);
    } finally {
      this.sessions.delete(session.state.sessionId);
    }
  }
  fail(session: Session, error: Error): void {
    if (
      session.state.lifecycle === "failed" ||
      session.state.lifecycle === "stopped" ||
      session.state.lifecycle === "stopping"
    )
      return;
    session.epoch++;
    session.latest = undefined;
    session.hub.clear();
    session.state = {
      ...session.state,
      lifecycle: "stopping",
      controller: "none",
      error: error.message.slice(0, 1024),
    };
    const releaseError = releaseControllerBinding(session);
    if (releaseError) {
      error = new Error(`${error.message}; ${releaseError.message}`);
      session.state = { ...session.state, error: error.message.slice(0, 1024) };
    }
    session.pixels.stop(error);
    this.emit(session);
    void session.recording?.stop().catch(() => {});
    session.recording = undefined;
    session.failureCleanup = (
      session.nativeStarted ? this.host.stopCapture(session.helper) : Promise.resolve()
    )
      .catch((cleanupError: unknown) => {
        if (!(cleanupError instanceof ScreenStopError && cleanupError.captureTerminated))
          throw cleanupError;
      })
      .then(async () => {
        if (!session.helper.capabilities?.background) await this.host.close();
        session.captureStopped.resolve();
        session.state = terminated(session.state);
        this.emit(session);
        this.sessions.delete(session.state.sessionId);
      });
    void session.failureCleanup.catch(() => {});
  }
}
