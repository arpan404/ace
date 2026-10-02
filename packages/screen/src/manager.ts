import {
  ScreenAction,
  ScreenBundle,
  ScreenInventory,
  ScreenPermissions,
  ScreenTarget,
  type ScreenState,
} from "@ace/protocol";
import { FrameHub, type Frame, type FrameSink } from "./frames.ts";
import { Helper, type HelperOptions } from "./helper.ts";
import {
  ScreenPolicy,
  bundles,
  takeControl,
  authorizeInput,
  stopping,
  terminated,
} from "./policy.ts";
import { Recording, type RecordingArtifact } from "./recording.ts";

export type ScreenOptions = Omit<HelperOptions, "onFrame" | "onFailure"> & {
  recordingDirectory: string;
  publishArtifact: (artifact: RecordingArtifact) => Promise<void>;
};
type Session = {
  state: ScreenState;
  helper: Helper;
  hub: FrameHub;
  latest: Frame | undefined;
  epoch: number;
  owner: string | undefined;
  recording: Recording | undefined;
  actionTail: Promise<void>;
  queuedActions: number;
  recordingStarting: boolean;
  stopping: Promise<void> | undefined;
};
export class ScreenManager {
  private readonly policy = new ScreenPolicy();
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(state: ScreenState) => void>();
  private readonly options: ScreenOptions;
  private reservations = 0;

  constructor(options: ScreenOptions) {
    this.options = options;
  }
  async enable(enabled: boolean): Promise<void> {
    this.policy.enable(enabled);
    if (!enabled) await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
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
      helper = await Helper.open({ ...this.options, onFrame: () => {}, onFailure: () => {} });
      return await helper.request({ op });
    } finally {
      this.reservations--;
      await helper?.close();
    }
  }
  async permissions(): Promise<ScreenPermissions> {
    return ScreenPermissions.parse(await this.inspect("permissions"));
  }
  async targets(): Promise<ScreenInventory> {
    if (!this.policy.enabled) throw new Error("Screen access is disabled");
    return ScreenInventory.parse(await this.inspect("targets"));
  }
  async start(input: ScreenTarget, fps = 10): Promise<ScreenState> {
    const target = ScreenTarget.parse(input);
    this.authorize(target);
    if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw new Error("Invalid frame rate");
    if (this.sessions.size + this.reservations >= 4) throw new Error("Session limit");
    this.reservations++;
    const epoch = this.policy.epoch;
    let helper: Helper | undefined;
    let session: Session | undefined;
    try {
      const id = this.options.nextId();
      if (this.sessions.has(id)) throw new Error("Duplicate session id");
      helper = await Helper.open({
        ...this.options,
        onFrame: (frame) => {
          if (
            !session ||
            (session.state.lifecycle !== "live" && session.state.lifecycle !== "starting")
          )
            return;
          if (
            frame.header.sessionId !== id ||
            frame.header.sequence <= (session.latest?.header.sequence ?? -1)
          ) {
            this.fail(session, new Error("Invalid frame sequence or session"));
            return;
          }
          this.authorize(target);
          session.latest = frame;
          if (session.state.lifecycle === "live") {
            session.hub.publish(frame);
            session.recording?.push(frame);
          }
        },
        onFailure: (error) => {
          if (session) this.fail(session, error);
        },
      });
      session = {
        helper,
        hub: new FrameHub(),
        epoch: 0,
        latest: undefined,
        owner: undefined,
        recording: undefined,
        actionTail: Promise.resolve(),
        queuedActions: 0,
        recordingStarting: false,
        stopping: undefined,
        state: {
          sessionId: id,
          lifecycle: "starting",
          controller: "none",
          indicator: false,
          target,
          permissions: { screenRecording: false, accessibility: false },
        },
      };
      this.sessions.set(id, session);
      session.state.permissions = ScreenPermissions.parse(
        await helper.request({ op: "permissions" }),
      );
      if (!session.state.permissions.screenRecording)
        throw new Error("Screen Recording permission denied");
      this.authorize(target);
      if (epoch !== this.policy.epoch) throw new Error("Screen policy changed during start");
      session.state = { ...session.state, indicator: true };
      this.emit(session);
      await helper.request({
        op: "start",
        sessionId: id,
        target,
        fps,
        allowlist: this.policy.allowlist(),
      });
      this.authorize(target);
      if (epoch !== this.policy.epoch || session.state.lifecycle !== "starting")
        throw new Error("Screen start cancelled");
      session.state = { ...session.state, lifecycle: "live", indicator: true };
      this.emit(session);
      return this.state(id);
    } catch (error) {
      if (session) {
        this.fail(session, error instanceof Error ? error : new Error("Start failed"));
      }
      await helper?.close();
      if (session) this.sessions.delete(session.state.sessionId);
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
    const stop = session.hub.subscribe(sink, session.latest);
    return stop;
  }
  screenshot(id: string): Frame {
    const session = this.live(id);
    this.authorize(session.state.target);
    if (!session.latest) throw new Error("No captured frame yet");
    return session.latest;
  }
  controller(id: string, controller: ScreenState["controller"], owner = "local"): void {
    const session = this.live(id);
    Object.assign(session, takeControl(session, controller, owner));
    this.emit(session);
  }
  async action(
    id: string,
    actor: "human" | "agent",
    input: ScreenAction,
    owner = "local",
  ): Promise<void> {
    const action = ScreenAction.parse(input);
    const session = this.live(id);
    this.authorize(session.state.target);
    authorizeInput(session, actor, owner);
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
        await session.helper.request({ op: "action", action });
      })
      .finally(() => {
        session.queuedActions--;
      });
    session.actionTail = execute.catch(() => {});
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
      );
      if (session.state.lifecycle !== "live" || session.recording) {
        await recording.stop();
        throw new Error("Recording start cancelled");
      }
      session.recording = recording;
    } finally {
      session.recordingStarting = false;
    }
  }
  async stopRecording(id: string): Promise<RecordingArtifact> {
    const session = this.get(id);
    const recording = session.recording;
    if (!recording) throw new Error("No recording active");
    session.recording = undefined;
    return recording.stop();
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
    await session.helper.close();
    session.state = terminated(session.state);
    this.emit(session);
    try {
      if (session.recording) await this.stopRecording(session.state.sessionId);
    } finally {
      this.sessions.delete(session.state.sessionId);
    }
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
    this.emit(session);
    void session.recording?.stop().catch(() => {});
    session.recording = undefined;
    void session.helper.close().then(() => {
      session.state = terminated(session.state);
      this.emit(session);
    });
  }
}
