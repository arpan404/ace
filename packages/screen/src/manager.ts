import { ScreenMeasurementOptions } from "@ace/protocol";
import { validateMeasurementBudget } from "@ace/interaction";
import { measureSession } from "./measurement.ts";
import { humanDeviceInput } from "./device-input-policy.ts";
import { SessionObservations } from "./session-observations.ts";
import { TargetBusyError } from "./target-busy.ts";
import { ScreenAccessPolicy } from "./access-policy.ts";
import { SessionControllers } from "./session-controllers.ts";
import { TargetSessions } from "./target-sessions.ts";
import { startSessionRecording, stopSessionRecording } from "./session-recording.ts";
import { AppLaunches } from "./app-launches.ts";
import { executeSessionAction } from "./action-execution.ts";
import { ScreenStreamSettings } from "@ace/protocol";
import { HelperCommandError } from "./helper.ts";
import type { ScreenAccess } from "./access.ts";
import { captureModelImage } from "./model-capture.ts";
import { legacyModelAction } from "./model-coordinates.ts";
import { dispatchLegacyAction } from "./legacy-input.ts";
import { ScreenAgentScope } from "@ace/protocol";
import { agentOwner, agentScope } from "./agent-binding.ts";
import {
  ScreenAction,
  ScreenInventory,
  ScreenPermissions,
  ScreenTarget,
  ScreenUIActOptions,
  ScreenInput,
  type ScreenState,
} from "@ace/protocol";
import { type Frame, type FrameSink } from "./frames.ts";
import { type Helper } from "./helper.ts";
import { ScreenPolicy, bundles } from "./policy.ts";
import { actOnElement } from "./semantic.ts";
import { shutdownFailure } from "./shutdown-failure.ts";
import { HelperHost } from "./helper-host.ts";
import { type Session, type ControllerBinding } from "./session.ts";
import { type RecordingArtifact } from "./recording.ts";

export type { ScreenOptions } from "./options.ts";
import type { ScreenOptions } from "./options.ts";
export class ScreenManager {
  private readonly policy = new ScreenPolicy();
  private readonly sessions = new Map<string, Session>();
  private readonly enabledListeners = new Set<(enabled: boolean) => void>();
  private readonly listeners = new Set<(state: ScreenState) => void>();
  private readonly options: ScreenOptions;
  private reservations = 0;
  private readonly host: HelperHost;
  private readonly launches: AppLaunches;
  private readonly lifecycle: TargetSessions;
  private readonly controllers: SessionControllers;
  private readonly accessPolicy: ScreenAccessPolicy;
  private readonly observations: SessionObservations;
  private agentPaused = false;
  private captureGeneration = 0;

  constructor(options: ScreenOptions) {
    this.options = options;
    this.host = new HelperHost({
      ...options,
      onFrame: (frame) => {
        const session = this.sessions.get(frame.header.sessionId);
        if (!session || !["live", "starting"].includes(session.state.lifecycle)) return;
        if (!session.pixels.accepts(frame)) return;
        try {
          if (frame.header.sequence <= (session.latest?.header.sequence ?? -1))
            throw new Error("Invalid frame sequence or session");
          this.authorize(session.state.target, session.approvalScope);
          session.latest = frame;
          session.pixels.frame(frame);
          if (session.state.lifecycle === "live") {
            session.hub.publish(frame);
            session.recording?.push(frame);
          }
        } catch (error) {
          this.fail(session, error instanceof Error ? error : new Error("Invalid frame"));
        }
      },
      onFailure: (error) => {
        for (const session of this.sessions.values()) this.fail(session, error);
      },
    });
    this.observations = new SessionObservations({
      live: (id) => this.live(id),
      authorize: (target, scope) => this.authorize(target, scope),
      options,
      releaseUnused: (session) => this.releaseUnused(session),
    });
    this.controllers = new SessionControllers({
      sessions: this.sessions,
      live: (id) => this.live(id),
      authorize: (target, scope) => this.authorize(target, scope),
      paused: () => this.agentPaused,
      emit: (session) => this.emit(session),
      releaseUnused: (session) => this.releaseUnused(session),
    });
    this.lifecycle = new TargetSessions({
      options,
      host: this.host,
      policy: this.policy,
      sessions: this.sessions,
      authorize: (target, scope) => this.authorize(target, scope),
      emit: (session) => this.emit(session),
      nextGeneration: () => ++this.captureGeneration,
    });
    this.launches = new AppLaunches(this.host, (bundleId, caller) =>
      this.authorize({ kind: "app", bundleId }, caller),
    );
    this.accessPolicy = new ScreenAccessPolicy({
      sessions: this.sessions,
      policy: this.policy,
      host: this.host,
      launches: this.launches,
      stop: (id) => this.stop(id),
      revalidate: () => this.revalidate(),
      enabledChanged: (enabled) => this.emitEnabled(enabled),
      resumeAgents: () => {
        this.agentPaused = false;
      },
    });
  }
  isEnabled(): boolean {
    return this.policy.enabled;
  }
  watchEnabled(listener: (enabled: boolean) => void): () => void {
    if (this.enabledListeners.size >= 64) throw new Error("Screen observer limit");
    this.enabledListeners.add(listener);
    return () => {
      this.enabledListeners.delete(listener);
    };
  }
  private emitEnabled(enabled: boolean): void {
    for (const listener of this.enabledListeners) {
      try {
        listener(enabled);
      } catch {
        /* An observer cannot prevent shutdown. */
      }
    }
  }
  enable(enabled: boolean): Promise<void> {
    return this.accessPolicy.enable(enabled);
  }
  approve(
    bundleId: string,
    allowed: boolean,
    scope: import("@ace/protocol").ScreenGrant["scope"] = "always",
    threadId?: string,
  ): Promise<void> {
    return this.accessPolicy.approve(bundleId, allowed, scope, threadId);
  }
  allow(bundleId: string): Promise<void> {
    return this.accessPolicy.allow(bundleId);
  }
  /**
   * The helper's macOS permissions as a newly started helper sees them. macOS applies a grant
   * only to processes started after it, so an idle helper is replaced before asking.
   */
  async currentPermissions(): Promise<ScreenPermissions> {
    if (this.sessions.size === 0 && !this.lifecycle.pendingCount && this.reservations === 0)
      await this.host.close();
    return this.permissions();
  }
  /**
   * Ask macOS for a permission on behalf of a person: its prompt the first time, then the
   * matching Privacy & Security pane, on the daemon's Mac.
   */
  async requestPermission(
    permission: "screenRecording" | "accessibility",
  ): Promise<ScreenPermissions> {
    const helper = await this.host.open();
    return ScreenPermissions.parse(await helper.request({ op: "permissions.request", permission }));
  }
  requireApproval(bundleId: string): void {
    this.accessPolicy.requireApproval(bundleId);
  }
  configureAccess(access: ScreenAccess): void {
    this.accessPolicy.configureAccess(access);
  }
  hasAppApproval(caller: ScreenAgentScope): boolean {
    return this.accessPolicy.hasAppApproval(caller);
  }
  approvals(threadId?: string) {
    return this.accessPolicy.approvals(threadId);
  }
  private authorize(target: ScreenTarget, scope?: ScreenAgentScope): void {
    this.accessPolicy.authorize(target, scope);
  }
  requestApp(
    bundleId: string,
    reason: string,
    caller: ScreenAgentScope,
    signal: AbortSignal,
  ): Promise<void> {
    return this.accessPolicy.requestApp(bundleId, reason, caller, signal);
  }
  async openApp(bundleId: string, caller?: ScreenAgentScope, signal?: AbortSignal) {
    return this.launches.open(bundleId, caller, signal);
  }
  async openAgentApp(bundleId: string, caller: ScreenAgentScope, signal: AbortSignal) {
    if (this.agentPaused)
      throw new HelperCommandError("permission_denied", "Computer use stopped by human");
    const existing = [...this.sessions.values()].find((session) =>
      bundles(session.state.target).includes(bundleId),
    );
    if (existing) {
      this.authorize(existing.state.target, caller);
      if (existing.owner !== agentOwner(caller))
        throw new TargetBusyError(
          bundleId,
          existing.state.sessionId,
          existing.owner ?? existing.state.controller,
        );
      return this.state(existing.state.sessionId);
    }
    await this.openApp(bundleId, caller, signal);
    signal.throwIfAborted();
    const inventory = await this.targets();
    signal.throwIfAborted();
    const window = inventory.windows.find((candidate) => candidate.bundleId === bundleId);
    const target: ScreenTarget = window
      ? { kind: "window", bundleId, windowId: window.windowId }
      : { kind: "app", bundleId };
    const state = await this.start(target, 10, caller);
    if (signal.aborted) {
      await this.stop(state.sessionId);
      signal.throwIfAborted();
    }
    this.delegateAgent(state.sessionId, caller);
    return this.state(state.sessionId);
  }
  async revalidate() {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => {
          try {
            this.authorize(session.state.target, session.approvalScope);
            return false;
          } catch {
            return true;
          }
        })
        .map((session) => this.stop(session.state.sessionId)),
    );
  }
  async mode(
    id: string,
    mode: ScreenState["mode"],
    signal = new AbortController().signal,
    reason = "This app requires foreground input",
  ) {
    const session = this.live(id),
      epoch = session.epoch;
    if (mode === "foreground") {
      if (!this.accessPolicy.access) throw new Error("Host approval unavailable");
      const cancelled = new AbortController();
      const unwatch = this.watch(() => {
        if (epoch !== session.epoch || session.state.lifecycle !== "live")
          cancelled.abort(new Error("Controller changed"));
      });
      try {
        await this.accessPolicy.access.foreground(
          this.state(id),
          reason,
          AbortSignal.any([signal, cancelled.signal]),
        );
      } finally {
        unwatch();
      }
    }
    signal.throwIfAborted();
    if (epoch !== session.epoch || session.state.lifecycle !== "live")
      throw new Error("Controller changed");
    this.authorize(session.state.target, session.approvalScope);
    session.epoch++;
    session.state = { ...session.state, mode };
    this.emit(session);
    return this.state(id);
  }
  secureInput(id: string, allowed: boolean) {
    const session = this.live(id);
    session.epoch++;
    session.state = { ...session.state, secureInputAllowed: allowed };
    this.emit(session);
  }
  async stopAll() {
    this.accessPolicy.access?.enable(false);
    const changed = this.policy.enabled;
    this.policy.enable(false);
    if (changed) this.emitEnabled(false);
    await this.terminateAll();
  }
  private async terminateAll() {
    this.launches.invalidate();
    this.agentPaused = true;
    this.policy.epoch++;
    for (const session of this.sessions.values())
      if (session.state.lifecycle === "live") this.controller(session.state.sessionId, "none");
    const results = await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id)));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    await this.lifecycle.drain();
    await this.launches.drain();
    if (errors.length) throw shutdownFailure(errors, results.length);
  }
  private async inspect(op: "permissions" | "targets"): Promise<unknown> {
    if (this.reservations >= 4) throw new Error("Helper inspection limit");
    this.reservations++;
    let helper: Helper | undefined;
    try {
      helper = await this.host.open();
      return await helper.request({ op });
    } finally {
      this.reservations--;
    }
  }
  async capabilities(_id?: string) {
    return (await this.host.open()).negotiate();
  }
  async permissions(): Promise<ScreenPermissions> {
    return ScreenPermissions.parse(await this.inspect("permissions"));
  }
  async targets(): Promise<ScreenInventory> {
    if (!this.policy.enabled)
      throw new HelperCommandError("screen_disabled", "Screen access is disabled");
    await Promise.all([...this.sessions.values()].map((session) => session.pixels.settle()));
    return ScreenInventory.parse(await this.inspect("targets"));
  }
  start(input: ScreenTarget, fps = 10, scope?: ScreenAgentScope): Promise<ScreenState> {
    return this.lifecycle.start(input, fps, scope);
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
    return this.observations.subscribe(id, sink);
  }
  screenshot(id: string): Frame {
    return this.observations.screenshot(id);
  }
  configureStream(id: string, settings: ScreenStreamSettings) {
    return this.observations.configureStream(id, settings);
  }
  requestKeyframe(id: string): Promise<void> {
    return this.observations.requestKeyframe(id);
  }
  captureScreenshot(id: string): Promise<Frame> {
    return this.observations.captureScreenshot(id);
  }
  uiTree(id: string, options: unknown, owner?: string) {
    return this.observations.uiTree(id, options, owner);
  }
  uiFind(id: string, options: unknown, owner?: string) {
    return this.observations.uiFind(id, options, owner);
  }
  async uiAct(
    id: string,
    actor: "human" | "agent",
    options: unknown,
    owner = "local",
    beforeDispatch?: () => void,
  ) {
    const action = ScreenUIActOptions.parse(options);
    return this.execute(
      id,
      actor,
      owner,
      (session, validate) => {
        return actOnElement(
          session.helper,
          session.state.target,
          bundles(session.state.target),
          action,
          () => {
            validate();
            beforeDispatch?.();
            validate();
          },
        );
      },
      action.action,
    );
  }
  async input(
    id: string,
    actor: "human" | "agent",
    options: unknown,
    owner = "local",
    beforeDispatch?: () => void,
  ) {
    const input = ScreenInput.parse(options);
    return this.execute(
      id,
      actor,
      owner,
      (session, validate) => {
        if (!session.helper.capabilities) throw new Error("V2 input not supported by helper");
        if (input.kind === "pointer.down") session.pointerDown = true;
        return session.helper
          .request(
            { op: "input", input, humanDeviceInput: humanDeviceInput(actor, session.state.target) },
            () => {
              validate();
              beforeDispatch?.();
              validate();
            },
          )
          .then((result) => {
            if (input.kind === "pointer.up" || input.kind === "pointer.cancel")
              session.pointerDown = false;
            return result;
          });
      },
      input.kind,
    );
  }
  /**
   * Press a button of the captured window by its accessible name, such as Simulator's Home,
   * Rotate and side buttons, with the same controller and permission checks as input.
   */
  async pressButton(
    id: string,
    actor: "human" | "agent",
    name: string,
    owner = "local",
    beforeDispatch?: () => void,
  ): Promise<void> {
    await this.execute(id, actor, owner, (session, validate) => {
      if (session.helper.capabilities?.platform !== "macos")
        throw new Error("Window buttons need the macOS helper");
      return session.helper.request(
        {
          op: "button.press",
          name,
          humanDeviceInput: humanDeviceInput(actor, session.state.target),
        },
        () => {
          validate();
          beforeDispatch?.();
          validate();
        },
      );
    });
  }
  async namedKey(
    id: string,
    input: {
      key: string;
      modifiers: ("control" | "shift" | "alt" | "meta" | "super" | "command" | "option")[];
    },
    owner: string,
  ): Promise<void> {
    await this.input(id, "agent", { kind: "key.press", ...input }, owner);
  }
  screenshotFresh(id: string): Promise<Frame> {
    return this.captureScreenshot(id);
  }
  delegateAgent(id: string, input: ScreenAgentScope): void {
    this.controllers.delegateAgent(id, input);
  }
  agentSession(input: ScreenAgentScope, requestedId?: string): string {
    return this.controllers.agentSession(input, requestedId);
  }
  async keyPress(
    id: string,
    key: string,
    modifiers: ("control" | "shift" | "alt" | "meta")[],
    owner: string,
  ): Promise<void> {
    await this.input(id, "agent", { kind: "key.press", key, modifiers }, owner);
  }
  controller(
    id: string,
    controller: ScreenState["controller"],
    owner = "local",
    binding?: ControllerBinding,
  ): void {
    this.controllers.controller(id, controller, owner, binding);
  }
  private releaseUnused(session: Session): void {
    if (
      !session.helper.capabilities?.platform.startsWith("linux") ||
      !session.hadViewer ||
      session.viewers ||
      session.state.controller === "agent" ||
      session.recording ||
      session.recordingStarting ||
      session.releasing ||
      session.state.lifecycle !== "live"
    )
      return;
    session.releasing = true;
    void session.actionTail
      .then(async () => {
        if (
          !session.viewers &&
          session.state.controller !== "agent" &&
          !session.recording &&
          !session.recordingStarting &&
          session.state.lifecycle === "live"
        )
          await this.stop(session.state.sessionId);
      })
      .catch(() => {})
      .finally(() => {
        session.releasing = false;
      });
  }
  async action(
    id: string,
    actor: "human" | "agent",
    input: ScreenAction,
    owner = "local",
    beforeDispatch?: () => void,
  ): Promise<void> {
    const action = ScreenAction.parse(input);
    await this.execute(
      id,
      actor,
      owner,
      (session, validate) =>
        dispatchLegacyAction(session, action, () => {
          validate();
          beforeDispatch?.();
          validate();
        }),
      action.kind,
    );
  }
  modelScreenshot(id: string, owner: string, signal: AbortSignal) {
    return captureModelImage(
      this.live(id),
      owner,
      () => this.captureScreenshot(id),
      signal,
      this.options.modelImageRuntime,
    );
  }
  async modelAction(
    id: string,
    owner: string,
    input: ScreenAction,
    beforeDispatch: () => void,
  ): Promise<void> {
    const action = ScreenAction.parse(input);
    await this.execute(
      id,
      "agent",
      owner,
      (session, validate) =>
        dispatchLegacyAction(session, legacyModelAction(session, owner, action), () => {
          validate();
          beforeDispatch();
          validate();
        }),
      action.kind,
    );
  }
  /** Observation needs an approved target, not an input controller or Accessibility grant. */
  measurementSession(caller: ScreenAgentScope, requestedId?: string): string {
    const sessions = [...this.sessions.values()].filter((session) => {
      if (
        session.state.lifecycle !== "live" ||
        (requestedId !== undefined && session.state.sessionId !== requestedId)
      )
        return false;
      try {
        this.authorize(session.state.target, caller);
        return true;
      } catch {
        return false;
      }
    });
    if (sessions.length !== 1) throw new Error("Select one approved live session with sessionId");
    const session = sessions[0];
    if (!session) throw new Error("Approved window required");
    return session.state.sessionId;
  }
  async measureInteraction(id: string, raw: unknown, owner: string, signal: AbortSignal) {
    const options = ScreenMeasurementOptions.parse(raw);
    validateMeasurementBudget(options);
    const session = this.live(id);
    const scope = agentScope(owner) ?? session.approvalScope;
    const validate = () => {
      signal.throwIfAborted();
      this.authorize(session.state.target, scope);
      if (session.state.lifecycle !== "live") throw new Error("Screen session is not live");
    };
    if (options.action)
      return this.execute(
        id,
        "agent",
        owner,
        (current, check) =>
          measureSession(current, options, () => {
            validate();
            check();
          }),
        "measure_interaction",
      );
    validate();
    if (session.queuedActions >= 16) throw new Error("Observation queue limit");
    session.queuedActions++;
    const task = session.actionTail
      .then(() => this.host.execute(validate, () => measureSession(session, options, validate)))
      .finally(() => {
        session.queuedActions--;
      });
    session.actionTail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private async execute<T>(
    id: string,
    actor: "human" | "agent",
    owner: string,
    dispatch: (session: Session, validate: () => void) => Promise<T>,
    actionName = "input",
  ): Promise<T> {
    return executeSessionAction(
      {
        host: this.host,
        authorize: (session) => this.authorize(session.state.target, session.approvalScope),
        emit: (session) => this.emit(session),
        fail: (session, error) => this.fail(session, error),
        audit: (state, action, outcome) => this.accessPolicy.access?.audit(state, action, outcome),
      },
      this.live(id),
      actor,
      owner,
      dispatch,
      actionName,
    );
  }

  releaseController(owner: string): void {
    this.controllers.releaseController(owner);
  }
  startRecording(id: string): Promise<void> {
    return startSessionRecording(this.live(id), this.options);
  }
  stopRecording(id: string): Promise<RecordingArtifact> {
    return stopSessionRecording(this.get(id));
  }
  stop(id: string): Promise<void> {
    return this.lifecycle.stop(id);
  }
  async close(): Promise<void> {
    this.policy.enable(false);
    try {
      await this.terminateAll();
    } finally {
      try {
        await this.host.close();
      } finally {
        this.listeners.clear();
        this.enabledListeners.clear();
      }
    }
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
    this.lifecycle.fail(session, error);
  }
}
