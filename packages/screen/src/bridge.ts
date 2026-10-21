import { TargetBusyError } from "./target-busy.ts";
import {
  ScreenAck,
  ScreenError,
  ScreenClientMessage,
  ScreenState,
  type ScreenServerMessage,
} from "@ace/protocol";
import { streamKinds } from "@ace/browser/stream";
import {
  LinkFollow,
  PictureChannel,
  pictureLinkLimits,
  type PictureTransport,
} from "@ace/browser/picture-channel";
import { framePicture } from "./frame-picture.ts";
import type { ScreenManager } from "./manager.ts";
import type { Simulators } from "./simulator.ts";

export type ScreenPeer = {
  send: (message: ScreenServerMessage) => void;
  /** The shared media stream: one binary message (a stream piece) per write. */
  media: PictureTransport;
  /** A write failed or access was revoked: the transport should close. */
  failed?(error: unknown): void;
  /** Clock for keyframe pacing; defaults to the wall clock and timers. */
  now?(): number;
  after?(ms: number, run: () => void): () => void;
};
/**
 * Attach only after the host transport authenticates a human device. A subscribed session's
 * pictures go out as stream kind `screenFrame`, paced by the viewer's `screen.ack`.
 */
export function screenConnection(
  manager: ScreenManager,
  simulators: Simulators,
  owner: string,
  peer: ScreenPeer,
): { request(input: unknown): Promise<void>; ack(input: unknown): void; close(): void } {
  const subscriptions = new Map<string, () => void>();
  let closed = false;
  let pending = 0;
  const later =
    peer.after ??
    ((ms: number, run: () => void) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  /** Each watched session's stream request, kept within this viewer's link. */
  const follows = new Map<string, LinkFollow>();
  let cancelTick: (() => void) | undefined;
  const tick = () => {
    for (const follow of follows.values()) follow.tick();
    cancelTick = follows.size && !closed ? later(1000, tick) : undefined;
  };
  const pictures = new PictureChannel(streamKinds.screenFrame, {
    transport: peer.media,
    now: peer.now ?? (() => performance.now()),
    after:
      peer.after ??
      ((ms, run) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      }),
    failed: (error) => {
      // Pictures that can't get out end every view on this connection; the host closes it.
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
      peer.failed?.(error);
    },
  });
  const unwatch = manager.watch((state) => {
    if (!closed) peer.send({ type: "screen.state", state });
  });
  const unwatchEnabled = manager.watchEnabled((enabled) => {
    if (!closed) peer.send({ type: "screen.enabled", enabled });
  });
  return {
    async request(input) {
      const { requestId, operation } = ScreenClientMessage.parse(input);
      const respond = (
        result: Omit<Extract<ScreenServerMessage, { type: "screen.result" }>, "type" | "requestId">,
      ) => {
        if (!closed) peer.send({ type: "screen.result", requestId, ...result });
      };
      if (closed) return;
      if (pending >= 16) {
        respond({ ok: false, error: "Screen request limit" });
        return;
      }
      pending++;
      try {
        let data: unknown;
        switch (operation.op) {
          case "status":
            data = {
              enabled: manager.isEnabled(),
              permissions: await manager.currentPermissions(),
              sessions: manager.states().length,
            };
            break;
          case "permissions.request":
            data = await manager.requestPermission(operation.permission);
            break;
          case "enable":
            await manager.enable(operation.enabled);
            break;
          case "stop.all":
            await manager.stopAll();
            break;
          case "mode":
            data = manager.mode(operation.sessionId, operation.mode);
            break;
          case "secure.input":
            manager.secureInput(operation.sessionId, operation.allowed);
            data = manager.state(operation.sessionId);
            break;
          case "open.app":
            data = await manager.openApp(operation.bundleId);
            break;
          case "capabilities":
            data = await manager.capabilities();
            break;
          case "ui.tree":
            data = await manager.uiTree(operation.sessionId, operation, owner);
            break;
          case "ui.find":
            data = await manager.uiFind(operation.sessionId, operation, owner);
            break;
          case "ui.act":
            data = await manager.uiAct(operation.sessionId, "human", operation, owner);
            break;
          case "input":
            data = await manager.input(operation.sessionId, "human", operation.input, owner);
            break;
          case "permissions":
            data = await manager.permissions();
            break;
          case "sessions":
            data = manager.states();
            break;
          case "targets":
            data = await manager.targets();
            break;
          case "start": {
            const state = await manager.start(
              operation.target,
              operation.fps,
              operation.threadId ? { threadId: operation.threadId, agentId: "human" } : undefined,
            );
            if (closed) await manager.stop(state.sessionId);
            else data = state;
            break;
          }
          case "stop":
            await manager.stop(operation.sessionId);
            break;
          case "controller":
            if (operation.controller === "agent" && (!operation.agentId || !operation.threadId))
              throw new Error("Agent and thread required for delegation");
            if (operation.controller === "agent" && operation.agentId && operation.threadId)
              manager.delegateAgent(operation.sessionId, {
                agentId: operation.agentId,
                threadId: operation.threadId,
              });
            else
              manager.controller(
                operation.sessionId,
                operation.controller,
                operation.controller === "agent" ? operation.agentId : owner,
              );
            break;
          case "action":
            await manager.action(operation.sessionId, "human", operation.action, owner);
            break;
          case "subscribe": {
            subscriptions.get(operation.sessionId)?.();
            subscriptions.delete(operation.sessionId);
            if (subscriptions.size >= 8) throw new Error("Screen subscription limit");
            const sessionId = operation.sessionId;
            const view = pictures.open(sessionId, {
              keyframe: () => void manager.requestKeyframe(sessionId).catch(() => {}),
              guard: () => {
                if (closed) throw new Error("Screen connection closed");
              },
              link: pictureLinkLimits,
            });
            const follow = new LinkFollow({
              rate: () => view.rate(),
              apply: (settings) => manager.configureStream(sessionId, settings),
            });
            try {
              // Every frame, unhurried: the viewer's window paces the pictures, not the hub.
              const stop = manager.subscribeEvery(sessionId, (frame) => {
                if (!closed) view.push(framePicture(frame));
              });
              follows.set(sessionId, follow);
              cancelTick ??= later(1000, tick);
              subscriptions.set(sessionId, () => {
                stop();
                view.close();
                follow.close();
                if (follows.get(sessionId) === follow) follows.delete(sessionId);
              });
            } catch (error) {
              view.close();
              throw error;
            }
            peer.send({
              type: "screen.state",
              state: ScreenState.parse(manager.state(operation.sessionId)),
            });
            break;
          }
          case "stream.configure": {
            // The view's request, with its bit rate held to what its link carries.
            const follow = follows.get(operation.sessionId);
            data = follow
              ? await follow.ask(operation.settings)
              : await manager.configureStream(operation.sessionId, operation.settings);
            break;
          }
          case "unsubscribe":
            subscriptions.get(operation.sessionId)?.();
            subscriptions.delete(operation.sessionId);
            break;
          case "record.start":
            await manager.startRecording(operation.sessionId);
            break;
          case "record.stop":
            data = await manager.stopRecording(operation.sessionId);
            break;
          case "simulators":
            data = await simulators.list();
            break;
          case "simulator.boot":
            await simulators.boot(operation.udid);
            break;
        }
        respond({ ok: true, data });
      } catch (error) {
        respond({
          ok: false,
          error: error instanceof Error ? error.message : "Screen request failed",
          ...(error instanceof Error &&
          "code" in error &&
          ScreenError.shape.code.safeParse(error.code).success
            ? { errorCode: ScreenError.shape.code.parse(error.code) }
            : {}),
          ...(error instanceof TargetBusyError ? { holder: error.holder } : {}),
        });
      } finally {
        pending--;
      }
    },
    ack(input) {
      const message = ScreenAck.parse(input);
      if (!closed)
        pictures.ack(message.sessionId, message.streamId, message.sequence, message.keyframe);
    },
    close() {
      closed = true;
      cancelTick?.();
      cancelTick = undefined;
      pictures.close();
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
      unwatch();
      unwatchEnabled();
      manager.releaseController(owner);
    },
  };
}
