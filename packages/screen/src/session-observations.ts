import type { HelperHost } from "./helper-host.ts";
import { z } from "zod";
import { ScreenStreamSettings, type ScreenTarget, type ScreenAgentScope } from "@ace/protocol";
import type { Frame, FrameSink } from "./frames.ts";
import type { Session } from "./session.ts";
import type { ScreenOptions } from "./options.ts";
import { nodeScheduler } from "./runtime.ts";
import { bundles } from "./policy.ts";
import { readTree, findElements } from "./semantic.ts";
type ObservationPorts = {
  host: HelperHost;
  live(id: string): Session;
  authorize(target: ScreenTarget, scope?: ScreenAgentScope, humanView?: boolean): void;
  releaseUnused(session: Session): void;
  options: ScreenOptions;
};
/** Pixel leases and fresh semantic reads do not acquire an agent controller. */
export class SessionObservations {
  private readonly host: HelperHost;
  private readonly live: ObservationPorts["live"];
  private readonly authorize: ObservationPorts["authorize"];
  private readonly releaseUnused: ObservationPorts["releaseUnused"];
  private readonly options: ScreenOptions;
  constructor(ports: ObservationPorts) {
    this.host = ports.host;
    this.live = ports.live;
    this.authorize = ports.authorize;
    this.releaseUnused = ports.releaseUnused;
    this.options = ports.options;
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
    this.authorize(session.state.target, session.approvalScope, session.humanView);
    if (!session.latest) throw new Error("No captured frame yet");
    return session.latest;
  }
  async configureStream(
    id: string,
    raw: ScreenStreamSettings,
  ): Promise<{ codec: "jpeg" | "h264" }> {
    const settings = ScreenStreamSettings.parse(raw);
    const session = this.live(id);
    this.authorize(session.state.target, session.approvalScope, session.humanView);
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
    this.authorize(session.state.target, session.approvalScope, session.humanView);
    if (session.helper.capabilities?.platform === "macos")
      await session.helper.request({ op: "stream.keyframe" });
  }
  async captureScreenshot(id: string): Promise<Frame> {
    const session = this.live(id);
    this.authorize(session.state.target, session.approvalScope, session.humanView);
    if (!session.helper.capabilities || session.helper.capabilities.platform.startsWith("linux"))
      return this.screenshot(id);
    const lease = session.pixels.acquire();
    try {
      await lease.ready;
      if (session.helper.capabilities.platform === "macos") {
        session.pixels.invalidateImage();
        await session.helper.request({ op: "stream.image" });
      }
      return await session.pixels.screenshot(
        this.options.scheduler ?? nodeScheduler,
        this.options.timeoutMs ?? 10_000,
      );
    } finally {
      lease.release();
    }
  }

  private async readUI<T>(
    id: string,
    read: (session: Session) => Promise<T>,
    owner?: string,
  ): Promise<T> {
    const session = this.live(id);
    this.authorize(session.state.target, session.approvalScope);
    const epoch = session.epoch;
    const originalOwner = session.owner;
    const validate = () => {
      this.authorize(session.state.target, session.approvalScope);
      if (session.epoch !== epoch || (owner !== undefined && session.owner !== originalOwner))
        throw new Error("Controller ownership changed during UI read");
      if (session.state.lifecycle !== "live") throw new Error("Screen session is not live");
    };
    if (session.queuedActions >= 16) throw new Error("Observation queue limit");
    session.queuedActions++;
    const task = session.actionTail
      .then(() =>
        this.host.execute(validate, async () => {
          const result = await read(session);
          validate();
          return result;
        }),
      )
      .finally(() => {
        session.queuedActions--;
      });
    session.actionTail = task.then(
      () => {},
      () => {},
    );
    return task;
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
      (session) =>
        readTree(session.helper, session.state.target, bundles(session.state.target), options),
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
        findElements(session.helper, session.state.target, bundles(session.state.target), options),
      owner,
    );
  }
}
