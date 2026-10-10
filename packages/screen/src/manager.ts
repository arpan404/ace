import { selectSessionWindow, performAppOperation, type AppOperation } from "./app-session.ts";
import { AppWindows } from "./app-windows.ts";
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
import { ScreenPolicy, bundles, replaceableSession } from "./policy.ts";
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
  private readonly windows: AppWindows;
  private readonly lifecycle: TargetSessions;
  private readonly controllers: SessionControllers;
  private readonly accessPolicy: ScreenAccessPolicy;
  private readonly observations: SessionObservations;
  private agentPaused = false;
  private captureGeneration = 0;
  private authorizationRevision = 0;

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
          if (
            session.frameAuthorization?.policy !== this.policy.epoch ||
            session.frameAuthorization.revision !== this.authorizationRevision
          ) {
            this.authorize(session.state.target, session.approvalScope, session.humanView);
            session.frameAuthorization = {
              policy: this.policy.epoch,
              revision: this.authorizationRevision,
            };
          }
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
      onPermissionsChanged: (permissions) => {
        for (const session of this.sessions.values()) {
          session.state.permissions = permissions;
          this.emit(session);
          if (!permissions.screenRecording)
            this.fail(session, new Error("Screen Recording permission revoked"));
        }
        options.onPermissionsChanged?.(permissions);
      },
      onSessionFailure: (id, error) => {
        const session = this.sessions.get(id);
        if (session) this.fail(session, error);
      },
      onFailure: (error) => {
        for (const session of this.sessions.values()) this.fail(session, error);
      },
    });
    this.observations = new SessionObservations({
      host: this.host,
      live: (id) => this.live(id),
      authorize: (target, scope, humanView) => this.authorize(target, scope, humanView),
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
      authorize: (target, scope, humanView) => this.authorize(target, scope, humanView),
      emit: (session) => this.emit(session),
      nextGeneration: () => ++this.captureGeneration,
    });
    this.windows = new AppWindows(
      this.host,
      (bundleId, caller) => this.authorize({ kind: "app", bundleId }, caller),
      options.scheduler,
    );
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
      hostClosed: () => this.lifecycle.hostClosed(),
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
    this.authorizationRevision++;
    return this.accessPolicy.enable(enabled);
  }
  approve(
    bundleId: string,
    allowed: boolean,
    scope: import("@ace/protocol").ScreenGrant["scope"] = "always",
    threadId?: string,
  ): Promise<void> {
    this.authorizationRevision++;
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
    if (!this.policy.enabled) return { screenRecording: false, accessibility: false };
    if (
      this.sessions.size === 0 &&
      !this.lifecycle.pendingCount &&
      !this.launches.pendingCount &&
      this.reservations === 0
    )
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
    this.reservations++;
    try {
      const helper = await this.host.open();
      return ScreenPermissions.parse(
        await helper.request({ op: "permissions.request", permission }),
      );
    } finally {
      this.reservations--;
    }
  }
  requireApproval(bundleId: string, scope?: ScreenAgentScope): void {
    this.accessPolicy.requireApproval(bundleId, scope);
  }
  configureAccess(access: ScreenAccess): void {
    this.authorizationRevision++;
    this.accessPolicy.configureAccess(access);
  }
  hasAppApproval(caller: ScreenAgentScope): boolean {
    return this.accessPolicy.hasAppApproval(caller);
  }
  approvals(threadId?: string) {
    return this.accessPolicy.approvals(threadId);
  }
  private authorize(target: ScreenTarget, scope?: ScreenAgentScope, humanView = false): void {
    if (
      humanView &&
      scope === undefined &&
      target.kind === "window" &&
      target.bundleId === "com.apple.iphonesimulator"
    )
      return;
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
  async openAgentApp(
    bundleId: string,
    caller: ScreenAgentScope,
    signal: AbortSignal,
    windowId?: number,
  ) {
    this.reservations++;
    try {
      return await this.acquireAgentApp(bundleId, caller, signal, windowId);
    } finally {
      this.reservations--;
    }
  }
  private async acquireAgentApp(
    bundleId: string,
    caller: ScreenAgentScope,
    signal: AbortSignal,
    windowId?: number,
  ) {
    if (this.agentPaused)
      throw new HelperCommandError("permission_denied", "Computer use stopped by human");
    let existing = [...this.sessions.values()].find((session) =>
      bundles(session.state.target).includes(bundleId),
    );
    if (existing) {
      this.authorize(existing.state.target, caller);
      if (replaceableSession(existing)) {
        await this.stop(existing.state.sessionId);
        existing = undefined;
      }
    }
    if (existing) {
      if (existing.owner !== agentOwner(caller))
        throw new TargetBusyError(
          bundleId,
          existing.state.sessionId,
          existing.owner ?? existing.state.controller,
        );
      if (windowId !== undefined) {
        const state = await this.selectWindow(
          existing.state.sessionId,
          windowId,
          agentOwner(caller),
          () => signal.throwIfAborted(),
        );
        return { ...state, ...(await this.windows.list(bundleId, caller)) };
      }
      return {
        ...this.state(existing.state.sessionId),
        ...(await this.windows.list(bundleId, caller)),
      };
    }
    await this.openApp(bundleId, caller, signal);
    signal.throwIfAborted();
    const windows = await this.windows.ready(bundleId, caller, signal, windowId);
    const target: ScreenTarget =
      windows.selectedWindowId !== undefined
        ? { kind: "window", bundleId, windowId: windows.selectedWindowId }
        : { kind: "app", bundleId };
    const state = await this.start(target, 10, caller);
    if (signal.aborted) {
      await this.stop(state.sessionId);
      signal.throwIfAborted();
    }
    this.delegateAgent(state.sessionId, caller);
    return { ...this.state(state.sessionId), ...windows };
  }
  async listAppWindows(bundleId: string, caller?: ScreenAgentScope) {
    this.reservations++;
    try {
      return await this.windows.list(bundleId, caller);
    } finally {
      this.reservations--;
    }
  }
  async selectWindow(id: string, windowId: number, owner: string, beforeDispatch: () => void) {
    const current = this.live(id);
    if (!current.helper.capabilities?.windowSelection) {
      const caller = agentScope(owner),
        target = current.state.target;
      if (!caller || this.agentSession(caller, id) !== id || target.kind === "display")
        throw new Error("Agent app session required");
      const epoch = current.epoch;
      const validate = () => {
        beforeDispatch();
        this.agentSession(caller, id);
        if (current.epoch !== epoch) throw new Error("Controller changed");
      };
      const windows = await this.windows.list(target.bundleId, caller);
      if (
        !windows.windows.some((window) => window.windowId === windowId && window.usable !== false)
      )
        throw new HelperCommandError("target_gone", "Selected app window is unavailable");
      validate();
      await this.stop(id);
      beforeDispatch();
      const state = await this.start(
        { kind: "window", bundleId: target.bundleId, windowId },
        10,
        caller,
      );
      try {
        beforeDispatch();
        this.delegateAgent(state.sessionId, caller);
      } catch (error) {
        await this.stop(state.sessionId);
        throw error;
      }
      return this.state(state.sessionId);
    }
    await this.execute(
      id,
      "agent",
      owner,
      async (session, validate) => {
        await selectSessionWindow(session, windowId, validate, beforeDispatch);
        this.emit(session);
      },
      "window.select",
    );
    return this.state(id);
  }
  appOperation(id: string, operation: AppOperation, owner: string, beforeDispatch: () => void) {
    return this.execute(
      id,
      "agent",
      owner,
      (session, validate) => performAppOperation(session, operation, validate, beforeDispatch),
      operation.op,
    );
  }
  /** Local device viewing has no agent grant and cannot be requested through screen MCP. */
  startHumanDeviceView(target: ScreenTarget, fps = 10): Promise<ScreenState> {
    return this.lifecycle.startHumanView(target, fps);
  }
  async revalidate() {
    this.authorizationRevision++;
    for (const session of this.sessions.values()) this.expireForeground(session);
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => {
          try {
            this.authorize(session.state.target, session.approvalScope, session.humanView);
            session.frameAuthorization = {
              policy: this.policy.epoch,
              revision: this.authorizationRevision,
            };
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
    const turn =
      session.approvalScope &&
      this.accessPolicy.access?.currentTurn?.(session.approvalScope.threadId);
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
    this.authorize(session.state.target, session.approvalScope, session.humanView);
    session.epoch++;
    if (
      mode === "foreground" &&
      this.accessPolicy.access?.currentTurn &&
      (!turn ||
        turn !== this.accessPolicy.access.currentTurn(session.approvalScope?.threadId ?? ""))
    )
      throw new Error("Foreground approval turn ended");
    session.foregroundTurn = mode === "foreground" ? turn : undefined;
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
    const releaseErrors: unknown[] = [];
    for (const session of this.sessions.values()) {
      try {
        if (session.state.lifecycle === "live") this.controller(session.state.sessionId, "none");
      } catch (error) {
        releaseErrors.push(error);
      }
    }
    const results = await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id)));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    await this.lifecycle.drain();
    await this.launches.drain();
    if (errors.length || releaseErrors.length)
      throw shutdownFailure([...releaseErrors, ...errors], results.length);
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
  /** Device viewers can discover Simulator windows without enabling agent computer use. */
  async humanDeviceTargets(): Promise<ScreenInventory> {
    const inventory = ScreenInventory.parse(await this.inspect("targets"));
    return {
      displays: [],
      windows: inventory.windows.filter(
        (window) => window.bundleId === "com.apple.iphonesimulator",
      ),
    };
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
  delegateAgent(id: string, input: ScreenAgentScope): void {
    this.controllers.delegateAgent(id, input);
  }
  agentSession(input: ScreenAgentScope, requestedId?: string): string {
    return this.controllers.agentSession(input, requestedId);
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
  ) {
    const action = ScreenAction.parse(input);
    return this.execute(
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
  async modelAction(id: string, owner: string, input: ScreenAction, beforeDispatch: () => void) {
    const action = ScreenAction.parse(input);
    return this.execute(
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
        (session.owner !== undefined && session.owner !== agentOwner(caller)) ||
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
      if (!options.action && session.owner !== undefined && session.owner !== owner)
        throw new Error("Session belongs to another controller");
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
        authorize: (session) => {
          this.expireForeground(session);
          this.authorize(
            session.state.target,
            session.approvalScope,
            actor === "human" && session.humanView,
          );
        },
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

  turnEnded(threadId: string, turnId: string): void {
    this.authorizationRevision++;
    for (const session of this.sessions.values()) {
      if (session.approvalScope?.threadId !== threadId) continue;
      if (
        session.foregroundTurn === turnId ||
        this.accessPolicy.access?.currentTurn?.(threadId) === turnId
      )
        this.resetForeground(session);
    }
  }
  private resetForeground(session: Session): void {
    session.epoch++;
    session.foregroundTurn = undefined;
    session.state = { ...session.state, mode: "background", secureInputAllowed: false };
    this.emit(session);
  }
  private expireForeground(session: Session): void {
    if (session.state.mode !== "foreground" || !this.accessPolicy.access?.currentTurn) return;
    if (
      session.foregroundTurn &&
      session.approvalScope &&
      session.foregroundTurn ===
        this.accessPolicy.access.currentTurn(session.approvalScope.threadId)
    )
      return;
    this.resetForeground(session);
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
        await this.lifecycle.hostClosed();
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
