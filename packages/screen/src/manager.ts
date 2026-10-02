import { runControl } from "./control.ts";
import { z } from "zod";
import {
  ScreenAction,
  ScreenBundle,
  ScreenInventory,
  ScreenPermissions,
  ScreenTarget,
  ScreenCapabilities,
  ScreenUITreeInput,
  ScreenUIFindInput,
  ScreenUIActInput,
  ScreenUITreeResult,
  ScreenUIFindResult,
  ScreenUIActResult,
  ScreenNamedKey,
  type ScreenHelperRequestV2,
  type ScreenState,
} from "@ace/protocol";
import { FrameHub, type Frame, type FrameSink } from "./frames.ts";
import { Helper, type HelperOptions } from "./helper.ts";
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
};
export class ScreenManager {
  private shared: Promise<Helper> | undefined;
  private sharedFrame: ((frame: Frame) => void) | undefined;
  private sharedFailure: ((error: Error) => void) | undefined;
  private enabled = false;
  private readonly allowed = new Set<string>();
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(state: ScreenState) => void>();
  private readonly options: ScreenOptions;
  private reservations = 0;
  private policyEpoch = 0;
  constructor(options: ScreenOptions) {
    this.options = options;
  }
  async enable(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    this.policyEpoch++;
    if (!enabled) await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
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
  private hostHelper(): Promise<Helper> {
    this.shared ??= Helper.open({
      ...this.options,
      onFrame: (frame) => this.sharedFrame?.(frame),
      onFailure: (error) => {
        this.shared = undefined;
        this.sharedFailure?.(error);
      },
    }).catch((error: unknown) => {
      this.shared = undefined;
      throw error;
    });
    return this.shared;
  }
  private async openCapture(options: HelperOptions): Promise<Helper> {
    if (this.options.protocolVersion !== 2) return Helper.open(options);
    const helper = await this.hostHelper();
    this.sharedFrame = options.onFrame;
    this.sharedFailure = options.onFailure;
    return helper;
  }
  private async inspect(op: "permissions" | "targets"): Promise<unknown> {
    if (this.reservations >= 4) throw new Error("Helper inspection limit");
    this.reservations++;
    let helper: Helper | undefined;
    try {
      helper =
        this.options.protocolVersion === 2
          ? await this.hostHelper()
          : await Helper.open({ ...this.options, onFrame: () => {}, onFailure: () => {} });
      return await helper.request({ op });
    } finally {
      this.reservations--;
      if (this.options.protocolVersion !== 2) await helper?.close();
    }
  }
  async capabilities(): Promise<ScreenCapabilities | undefined> {
    if (this.options.protocolVersion !== 2) return undefined;
    return (await this.hostHelper()).capabilities;
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
    if (this.sessions.size + this.reservations >= (this.options.protocolVersion === 2 ? 1 : 4))
      throw new Error("Session limit");
    this.reservations++;
    const epoch = this.policyEpoch;
    let helper: Helper | undefined;
    let session: Session | undefined;
    try {
      const id = this.options.nextId();
      if (this.sessions.has(id)) throw new Error("Duplicate session id");
      helper = await this.openCapture({
        ...this.options,
        onFrame: (frame) => {
          if (
            !session ||
            (session.state.lifecycle !== "live" && session.state.lifecycle !== "starting")
          )
            return;
          if (this.options.protocolVersion === 2 && frame.header.sessionId !== id) return;
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
      const capabilities = helper.capabilities;
      if (capabilities) {
        if (capabilities.permissions.screen === "denied")
          throw new Error("Screen permission denied");
        if (
          target.kind === "display" ? !capabilities.capture.displays : !capabilities.capture.windows
        )
          throw new Error("Helper does not support this capture target");
      }
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
      if (epoch !== this.policyEpoch) throw new Error("Screen policy changed during start");
      const started: unknown = await helper.request({
        op: "start",
        sessionId: id,
        target,
        fps,
        allowlist: [...this.allowed],
      });
      if (capabilities) {
        const result = z.object({ capabilities: ScreenCapabilities }).parse(started);
        helper.capabilities = result.capabilities;
      }
      this.authorize(target);
      if (epoch !== this.policyEpoch || session.state.lifecycle !== "starting")
        throw new Error("Screen start cancelled");
      session.state = { ...session.state, lifecycle: "live", indicator: true };
      this.emit(session);
      return this.state(id);
    } catch (error) {
      if (session) {
        this.fail(session, error instanceof Error ? error : new Error("Start failed"));
        this.sessions.delete(session.state.sessionId);
      }
      await helper?.close();
      if (this.options.protocolVersion === 2) this.shared = undefined;
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
    session.epoch++;
    session.owner = controller === "none" ? undefined : owner;
    session.state = { ...session.state, controller };
    this.emit(session);
  }
  async action(
    id: string,
    actor: "human" | "agent",
    input: ScreenAction,
    owner = "local",
  ): Promise<void> {
    const action = ScreenAction.parse(input);
    return this.control(id, actor, owner, async (helper) => {
      const caps = helper.capabilities;
      if (!caps) {
        await helper.request({ op: "action", action });
        return;
      }
      const header = this.live(id).latest?.header;
      const scale = header?.version === 2 ? header.scale : 1;
      switch (action.kind) {
        case "click":
          if (!caps.input.pointer) throw new Error("Helper has no pointer support");
          await helper.request({
            op: "pointer.click",
            x: action.x / scale,
            y: action.y / scale,
            button: action.button,
          });
          break;
        case "type":
          if (!caps.input.text) throw new Error("Helper has no text support");
          await helper.request({ op: "text.type", text: action.text });
          break;
        case "scroll":
          if (!caps.input.scroll) throw new Error("Helper has no scroll support");
          await helper.request({ op: "pointer.move", x: action.x / scale, y: action.y / scale });
          await helper.request({ op: "scroll", dx: action.deltaX, dy: action.deltaY });
          break;
        case "key":
          throw new Error("Use a named key on protocol v2 helpers");
      }
    });
  }
  private async control(
    id: string,
    actor: "human" | "agent",
    owner: string,
    run: (helper: Helper) => Promise<void>,
  ): Promise<void> {
    const session = this.live(id);
    return runControl(
      session,
      actor,
      owner,
      {
        authorize: () => this.authorize(session.state.target),
        emit: () => this.emit(session),
        fail: (error) => this.fail(session, error),
      },
      run,
    );
  }

  async ui(
    id: string,
    input: Omit<
      Extract<ScreenHelperRequestV2, { op: "ui.tree" | "ui.find" | "ui.act" }>,
      "id" | "version"
    >,
    actor: "human" | "agent" = "agent",
    owner = "local",
  ): Promise<unknown> {
    const session = this.live(id);
    this.authorize(session.state.target);
    const caps = session.helper.capabilities;
    if (!caps?.uiTree) throw new Error("Helper has no UI tree support");
    if (input.op === "ui.tree")
      return ScreenUITreeResult.parse(
        await session.helper.request({ op: "ui.tree", ...ScreenUITreeInput.parse(input) }),
      );
    if (input.op === "ui.find")
      return ScreenUIFindResult.parse(
        await session.helper.request({ op: "ui.find", ...ScreenUIFindInput.parse(input) }),
      );
    const action = ScreenUIActInput.parse(input);
    if (!caps.semanticActions.includes(action.action))
      throw new Error("Helper does not support this semantic action");
    let result: unknown;
    await this.control(id, actor, owner, async (helper) => {
      result = ScreenUIActResult.parse(await helper.request({ op: "ui.act", ...action }));
    });
    return result;
  }
  async namedKey(id: string, input: z.infer<typeof ScreenNamedKey>, owner: string): Promise<void> {
    const key = ScreenNamedKey.parse(input);
    await this.control(id, "agent", owner, async (helper) => {
      if (!helper.capabilities?.input.keyboard) throw new Error("Helper has no named-key support");
      await helper.request({ op: "key.press", ...key });
    });
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
  async stop(id: string): Promise<void> {
    const session = this.get(id);
    const wasFailed = session.state.lifecycle === "failed";
    session.epoch++;
    session.latest = undefined;
    session.hub.clear();
    session.state = {
      ...session.state,
      lifecycle: "stopped",
      indicator: false,
      controller: "none",
    };
    this.emit(session);
    let failure: unknown;
    try {
      if (session.recording) await this.stopRecording(id);
    } catch (error) {
      failure = error;
    }
    try {
      if (this.options.protocolVersion === 2) {
        this.sharedFrame = undefined;
        this.sharedFailure = undefined;
        if (!wasFailed) await session.helper.request({ op: "stop" });
      } else await session.helper.close();
    } catch (error) {
      failure ??= error;
      this.shared = undefined;
      await session.helper.close();
    } finally {
      this.sessions.delete(id);
    }
    if (failure !== undefined) throw failure;
  }
  async close(): Promise<void> {
    try {
      await this.enable(false);
    } finally {
      try {
        await (await this.shared)?.close();
      } finally {
        this.shared = undefined;
        this.listeners.clear();
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
    if (session.state.lifecycle === "failed" || session.state.lifecycle === "stopped") return;
    session.epoch++;
    session.latest = undefined;
    session.hub.clear();
    session.state = {
      ...session.state,
      lifecycle: "failed",
      indicator: false,
      controller: "none",
      error: error.message.slice(0, 1024),
    };
    this.emit(session);
    if (this.options.protocolVersion === 2) {
      this.shared = undefined;
      this.sharedFrame = undefined;
      this.sharedFailure = undefined;
    }
    void session.recording?.stop().catch(() => {});
    session.recording = undefined;
    void session.helper.close();
  }
}
function bundles(target: ScreenTarget): string[] {
  return target.kind === "display" ? target.bundleIds : [target.bundleId];
}
