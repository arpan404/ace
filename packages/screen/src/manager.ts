import { z } from "zod";
import { ScreenStreamSettings } from "@ace/protocol";
import { ScreenStopError } from "./stop-error.ts";
import { ScreenAgentScope } from "@ace/protocol";
import { agentOwner } from "./agent-binding.ts";
import {
  ScreenAction,
  ScreenBundle,
  ScreenInventory,
  ScreenPermissions,
  ScreenTarget,
  ScreenUIActOptions,
  ScreenInput,
  ScreenCapabilities,
  type ScreenState,
} from "@ace/protocol";
import { type Frame, type FrameSink } from "./frames.ts";
import { type Helper, type HelperOptions } from "./helper.ts";
import {
  ScreenPolicy,
  bundles,
  takeControl,
  authorizeInput,
  stopping,
  terminated,
} from "./policy.ts";
import { readTree, findElements, actOnElement } from "./semantic.ts";
import { HelperHost } from "./helper-host.ts";
import { createSession, type Session, type ControllerBinding } from "./session.ts";
import { nodeScheduler } from "./runtime.ts";
import { Recording, type RecordingArtifact } from "./recording.ts";

export type ScreenOptions = Omit<HelperOptions, "onFrame" | "onFailure"> & {
  recordingDirectory: string;
  recordingLimitBytes?: number;
  publishArtifact: (artifact: RecordingArtifact) => Promise<void>;
};
export class ScreenManager {
  private readonly policy = new ScreenPolicy();
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(state: ScreenState) => void>();
  private readonly options: ScreenOptions;
  private reservations = 0;
  private readonly host: HelperHost;
  private starting = false;
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
          this.authorize(session.state.target);
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
  }
  async enable(enabled: boolean): Promise<void> {
    this.policy.enable(enabled);
    if (!enabled) {
      const sessions = [...this.sessions.values()];
      const results = Promise.allSettled(
        sessions.map((session) => this.stop(session.state.sessionId)),
      );
      await Promise.all(sessions.map((session) => session.captureStopped.promise));
      await this.host.close();
      const errors = (await results).flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Screen shutdown failed");
    }
  }
  async approve(bundleId: string, allowed: boolean): Promise<void> {
    ScreenBundle.parse(bundleId);
    this.policy.approve(bundleId, allowed);
    if (!allowed) {
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
    if (!this.policy.allowlist().includes(bundleId)) await this.approve(bundleId, true);
  }
  /**
   * The helper's macOS permissions as a newly started helper sees them. macOS applies a grant
   * only to processes started after it, so an idle helper is replaced before asking.
   */
  async currentPermissions(): Promise<ScreenPermissions> {
    if (this.sessions.size === 0 && !this.starting && this.reservations === 0)
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
    this.policy.authorize([ScreenBundle.parse(bundleId)]);
  }
  private authorize(target: ScreenTarget): void {
    this.policy.authorize(bundles(target));
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
    if (!this.policy.enabled) throw new Error("Screen access is disabled");
    await Promise.all([...this.sessions.values()].map((session) => session.pixels.settle()));
    return ScreenInventory.parse(await this.inspect("targets"));
  }
  async start(input: ScreenTarget, fps = 10): Promise<ScreenState> {
    const target = ScreenTarget.parse(input);
    this.authorize(target);
    if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error("Invalid frame rate");
    if (this.sessions.size >= 1 || this.starting) throw new Error("Session limit");
    this.starting = true;
    this.reservations++;
    const epoch = this.policy.epoch;
    let helper: Helper | undefined;
    let session: Session | undefined;
    try {
      const id = this.options.nextId();
      if (this.sessions.has(id)) throw new Error("Duplicate session id");
      helper = await this.host.open();
      if (
        helper.capabilities &&
        ((target.kind === "display" && !helper.capabilities.capture.displays) ||
          (target.kind !== "display" && !helper.capabilities.capture.windows))
      )
        throw new Error("Helper does not support capture target");
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
        () => ++this.captureGeneration,
      );
      this.sessions.set(id, session);
      session.state.permissions = ScreenPermissions.parse(
        await helper.request({ op: "permissions" }),
      );
      if (!session.state.permissions.screenRecording)
        throw new Error("Screen Recording permission denied");
      this.authorize(target);
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
        allowlist: this.policy.allowlist(),
      };
      if (helper.capabilities?.platform === "windows") {
        await helper.requestV2({ ...start, captureGeneration: session.pixels.startGeneration() });
        await session.pixels.initialize();
      } else {
        const result = await helper.request(start);
        if (helper.capabilities?.platform.startsWith("linux")) {
          if (!result || typeof result !== "object" || !("capabilities" in result))
            throw new Error("Missing capture capabilities");
          helper.capabilities = ScreenCapabilities.parse(result.capabilities);
          session.state.capabilities = helper.capabilities;
        }
      }
      this.authorize(target);
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
      if (session?.stopping) await session.stopping;
      if (helper) await this.host.close();
      if (session) {
        session.state = terminated(session.state);
        this.emit(session);
        this.sessions.delete(session.state.sessionId);
      }
      throw error;
    } finally {
      this.reservations--;
      this.starting = false;
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
    const lease = session.pixels.acquire();
    session.viewers++;
    session.hadViewer = true;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      lease.release();
      session.viewers--;
      this.releaseUnused(session);
    };
    try {
      const stop = session.hub.subscribe(async (frame) => {
        try {
          await sink(frame);
        } catch (error) {
          release();
          throw error;
        }
      }, session.latest);
      return () => {
        stop();
        release();
      };
    } catch (error) {
      release();
      throw error;
    }
  }
  screenshot(id: string): Frame {
    const session = this.live(id);
    this.authorize(session.state.target);
    if (!session.latest) throw new Error("No captured frame yet");
    return session.latest;
  }
  async configureStream(
    id: string,
    raw: ScreenStreamSettings,
  ): Promise<{ codec: "jpeg" | "h264" }> {
    const settings = ScreenStreamSettings.parse(raw);
    const session = this.live(id);
    this.authorize(session.state.target);
    if (
      session.helper.capabilities?.platform !== "macos" ||
      !session.helper.capabilities.codecs.includes("h264")
    )
      return { codec: "jpeg" };
    return z
      .object({ codec: z.enum(["jpeg", "h264"]) })
      .parse(await session.helper.request({ op: "stream.configure", settings }));
  }
  async requestKeyframe(id: string): Promise<void> {
    const session = this.live(id);
    this.authorize(session.state.target);
    if (session.helper.capabilities?.platform === "macos")
      await session.helper.request({ op: "stream.keyframe" });
  }
  async captureScreenshot(id: string): Promise<Frame> {
    const session = this.live(id);
    this.authorize(session.state.target);
    if (!session.helper.capabilities || session.helper.capabilities.platform.startsWith("linux"))
      return this.screenshot(id);
    if (session.latest?.header.codec === "h264") {
      session.pixels.invalidateImage();
      await session.helper.request({ op: "stream.image" });
    }
    return session.pixels.screenshot(
      this.options.scheduler ?? nodeScheduler,
      this.options.timeoutMs ?? 10_000,
    );
  }
  private async readUI<T>(
    id: string,
    read: (session: Session) => Promise<T>,
    owner?: string,
  ): Promise<T> {
    const session = this.live(id);
    this.authorize(session.state.target);
    const epoch = session.epoch;
    const originalOwner = session.owner;
    const result = await read(session);
    if (owner !== undefined && (session.owner !== originalOwner || session.epoch !== epoch))
      throw new Error("Controller ownership changed during UI read");
    this.authorize(session.state.target);
    if (session.state.lifecycle !== "live") throw new Error("Screen session is not live");
    return result;
  }
  uiTree(id: string, options: unknown, owner?: string) {
    if (
      owner !== undefined &&
      !this.live(id).helper.capabilities?.platform.startsWith("linux") &&
      this.live(id).owner !== owner
    )
      throw new Error("Controller ownership required");
    return this.readUI(
      id,
      (session) => readTree(session.helper, session.state.target, this.policy.allowlist(), options),
      owner,
    );
  }
  uiFind(id: string, options: unknown, owner?: string) {
    if (
      owner !== undefined &&
      !this.live(id).helper.capabilities?.platform.startsWith("linux") &&
      this.live(id).owner !== owner
    )
      throw new Error("Controller ownership required");
    return this.readUI(
      id,
      (session) =>
        findElements(session.helper, session.state.target, this.policy.allowlist(), options),
      owner,
    );
  }
  async uiAct(
    id: string,
    actor: "human" | "agent",
    options: unknown,
    owner = "local",
    beforeDispatch?: () => void,
  ) {
    const action = ScreenUIActOptions.parse(options);
    return this.execute(id, actor, owner, (session) => {
      beforeDispatch?.();
      return actOnElement(session.helper, session.state.target, this.policy.allowlist(), action);
    });
  }
  async input(
    id: string,
    actor: "human" | "agent",
    options: unknown,
    owner = "local",
    beforeDispatch?: () => void,
  ) {
    const input = ScreenInput.parse(options);
    await this.execute(id, actor, owner, (session) => {
      if (!session.helper.capabilities) throw new Error("V2 input not supported by helper");
      beforeDispatch?.();
      if (input.kind === "pointer.down") session.pointerDown = true;
      if (input.kind === "pointer.up" || input.kind === "pointer.cancel")
        session.pointerDown = false;
      return session.helper.request({ op: "input", input });
    });
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
    await this.execute(id, actor, owner, (session) => {
      if (session.helper.capabilities?.platform !== "macos")
        throw new Error("Window buttons need the macOS helper");
      beforeDispatch?.();
      return session.helper.request({ op: "button.press", name });
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
    this.controller(id, "agent", agentOwner(input));
  }
  agentSession(input: ScreenAgentScope): string {
    const owner = agentOwner(input);
    const session = [...this.sessions.values()].find(
      (candidate) =>
        candidate.state.lifecycle === "live" &&
        candidate.state.controller === "agent" &&
        candidate.owner === owner,
    );
    if (!session) throw new Error("Screen delegation required");
    session.controllerBinding?.authorize();
    this.authorize(session.state.target);
    return session.state.sessionId;
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
    const session = this.live(id);
    if (
      session.pointerDown &&
      session.helper.capabilities?.platform === "macos" &&
      (session.state.controller !== controller || session.owner !== owner)
    ) {
      session.pointerDown = false;
      void session.helper
        .request({ op: "input", input: { kind: "pointer.cancel" } })
        .catch(() => {});
    }
    if (session.controllerBinding) {
      // No old input remains authorized if an external release callback fails.
      Object.assign(session, takeControl(session, "none", owner));
      const error = this.releaseBinding(session);
      if (error) {
        this.emit(session);
        this.releaseUnused(session);
        throw error;
      }
    }
    Object.assign(session, takeControl(session, controller, owner));
    session.controllerBinding = controller === "none" ? undefined : binding;
    this.emit(session);
    this.releaseUnused(session);
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
  ): Promise<void> {
    const action = ScreenAction.parse(input);
    await this.execute(id, actor, owner, async (session) => {
      if (!session.helper.capabilities?.platform.startsWith("linux"))
        return session.helper.request({ op: "action", action });
      const scale = session.latest?.header.scale ?? 1;
      switch (action.kind) {
        case "click":
          return session.helper.requestV2({
            op: "pointer.click",
            x: action.x / scale,
            y: action.y / scale,
            button: action.button,
          });
        case "type":
          return session.helper.requestV2({ op: "text.type", text: action.text });
        case "scroll":
          await session.helper.requestV2({
            op: "pointer.move",
            x: action.x / scale,
            y: action.y / scale,
          });
          return session.helper.requestV2({ op: "scroll", dx: action.deltaX, dy: action.deltaY });
        case "key":
          throw new Error("Use a named key on protocol v2 helpers");
      }
    });
  }
  private async execute(
    id: string,
    actor: "human" | "agent",
    owner: string,
    dispatch: (session: Session) => Promise<unknown>,
  ): Promise<unknown> {
    const session = this.live(id);
    this.authorize(session.state.target);
    authorizeInput(session, actor, owner);
    session.controllerBinding?.authorize();
    if (session.queuedActions >= 16) throw new Error("Input queue limit");
    session.queuedActions++;
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
          throw new Error("macOS permission denied");
        this.authorize(session.state.target);
        if (
          session.epoch !== epoch ||
          session.state.controller !== actor ||
          session.state.lifecycle !== "live"
        )
          throw new Error("Controller changed");
        session.controllerBinding?.authorize();
        return dispatch(session);
      })
      .catch(async (error: unknown) => {
        if (session.state.lifecycle === "stopping" && session.state.error) await this.host.close();
        throw error;
      })
      .finally(() => {
        session.queuedActions--;
      });
    session.actionTail = execute.then(
      () => {},
      () => {},
    );
    return execute;
  }
  releaseController(owner: string): void {
    for (const session of this.sessions.values())
      if (session.owner === owner && session.state.lifecycle === "live")
        this.controller(session.state.sessionId, "none");
  }
  async startRecording(id: string): Promise<void> {
    const session = this.live(id);
    if (session.recording || session.recordingStarting) throw new Error("Recording already active");
    session.recordingStarting = true;
    try {
      const recording = await Recording.open(
        this.options.recordingDirectory,
        this.options.nextId(),
        this.options.publishArtifact,
        this.options.recordingLimitBytes,
        () => {
          if (session.recording === recording) {
            session.recording = undefined;
            session.completedRecording = recording;
          }
          session.recordingLease?.release();
          session.recordingLease = undefined;
        },
      );
      if (session.state.lifecycle !== "live" || session.recording) {
        await recording.stop();
        throw new Error("Recording start cancelled");
      }
      if (session.completedRecording) await session.completedRecording.stop();
      session.completedRecording = undefined;
      session.recording = recording;
      const lease = session.pixels.acquire();
      session.recordingLease = lease;
      await lease.ready;
    } finally {
      session.recordingStarting = false;
    }
  }
  async stopRecording(id: string): Promise<RecordingArtifact> {
    const session = this.get(id);
    const recording = session.recording ?? session.completedRecording;
    if (!recording) throw new Error("No recording active");
    session.recording = undefined;
    session.recordingLease?.release();
    session.recordingLease = undefined;
    const result = recording.stop();
    session.completedRecording = undefined;
    return result;
  }
  stop(id: string): Promise<void> {
    const session = this.get(id);
    session.stopping ??= this.finish(session);
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
    const releaseError = this.releaseBinding(session);
    if (releaseError) errors.push(releaseError);
    let captureTerminated = false;
    try {
      if (session.state.error) await this.host.close();
      else await this.host.stopCapture(session.helper);
      captureTerminated = true;
    } catch (error) {
      captureTerminated = error instanceof ScreenStopError && error.captureTerminated;
      errors.push(error);
    }
    session.captureStopped.resolve();
    session.state = terminated(session.state);
    this.emit(session);
    try {
      if (session.recording || session.completedRecording)
        await this.stopRecording(session.state.sessionId);
    } catch (error) {
      errors.push(error);
    } finally {
      this.sessions.delete(session.state.sessionId);
    }
    if (errors.length) throw new ScreenStopError(errors, captureTerminated);
  }
  async close(): Promise<void> {
    await this.enable(false);
    this.listeners.clear();
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
  private releaseBinding(session: Session): Error | undefined {
    const binding = session.controllerBinding;
    session.controllerBinding = undefined;
    try {
      binding?.released();
    } catch (error) {
      return error instanceof Error ? error : new Error("Controller release failed");
    }
    return undefined;
  }
  private fail(session: Session, error: Error): void {
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
    const releaseError = this.releaseBinding(session);
    if (releaseError) {
      error = new Error(`${error.message}; ${releaseError.message}`);
      session.state = { ...session.state, error: error.message.slice(0, 1024) };
    }
    session.pixels.stop(error);
    this.emit(session);
    void session.recording?.stop().catch(() => {});
    session.recording = undefined;
    void this.host.close().then(() => {
      session.state = terminated(session.state);
      this.emit(session);
    });
  }
}
