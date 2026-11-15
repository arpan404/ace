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
import {
  mediaSubscribed,
  viewLink,
  viewViewport,
  type MediaDeliveryPort,
} from "@ace/media/media-viewers";
import type { MediaOwner } from "@ace/media/media-connections";
import { framePicture } from "./frame-picture.ts";
import type { Frame } from "./frames.ts";
import type { VideoHost } from "@ace/browser";
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
  /**
   * The browser service's encoder-only Chrome: video from a helper that only makes JPEG (Linux,
   * Windows), so every platform's live view is video. Absent, such a view says it can't stream.
   */
  pictureEncoder?(): VideoHost | undefined;
  /**
   * Delivery by ace-media (D1) for subscribes that name a media connection, with who this
   * connection is: its session, device and admission (a main session, or a channel of its own).
   * Without it, or while ace-media doesn't serve screens, they are served here.
   */
  delivery?: { owner: () => MediaOwner | undefined; port: () => MediaDeliveryPort | undefined };
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
  /** Watched sessions ace-media delivers, by their viewer there. */
  const delivered = new Map<string, string>();
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
  /**
   * A subscribe naming a media connection: its viewer there, while ace-media delivers screens. A
   * connection of another session is refused.
   */
  const bindMedia = (
    sessionId: string,
    connection: string,
    operation: { link?: Parameters<typeof viewLink>[0]; codecs?: string[] | undefined },
  ): string | undefined => {
    const delivery = peer.delivery;
    const port = delivery?.port();
    const requester = delivery?.owner();
    if (!requester || !port || !port.serves("screen")) return undefined;
    const viewer = `${requester.session}/screen/${sessionId}`.slice(0, 64);
    const link = viewLink(operation.link);
    const bound = port.bind({
      viewer,
      requester,
      connection,
      target: { kind: "screen", sessionId },
      codecs: operation.codecs ?? ["avc1.42E033"],
      // The viewer says its size with `stream.configure`; until then, a desktop pane.
      viewport: viewViewport({ width: 1280, height: 800, devicePixelRatio: 2 }),
      local: false,
      audio: false,
      ...(link ? { link } : {}),
      shows: (producer) => producer.kind === "screen" && producer.sessionId === sessionId,
    });
    if (!bound) throw new Error("media-connection: that media connection isn't this session's");
    delivered.set(sessionId, viewer);
    return viewer;
  };
  return {
    async request(input) {
      const parsed = ScreenClientMessage.safeParse(input);
      if (!parsed.success) {
        // A request it can't read still gets an answer, so its sender doesn't wait it out.
        const id = ScreenClientMessage.pick({ requestId: true }).safeParse(input);
        if (id.success && !closed)
          peer.send({
            type: "screen.result",
            requestId: id.data.requestId,
            ok: false,
            error: "Invalid screen request",
            errorCode: "bounds",
          });
        throw parsed.error;
      }
      const { requestId, operation } = parsed.data;
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
            const viewer = operation.media
              ? bindMedia(sessionId, operation.media.connection, operation)
              : undefined;
            const now = peer.now ?? (() => performance.now());
            // Video for a helper that makes only JPEG; the Mac's helper encodes its own.
            const converter = manager.openPictureVideo({
              host: () => peer.pictureEncoder?.(),
              sessionId,
              now,
              frame: (frame: Frame) => {
                if (!closed) view.push(framePicture(frame));
              },
            });
            const view = pictures.open(sessionId, {
              keyframe: () => {
                if (!converter.keyframe()) void manager.requestKeyframe(sessionId).catch(() => {});
              },
              guard: () => {
                if (closed) throw new Error("Screen connection closed");
              },
              link: pictureLinkLimits,
            });
            const follow = new LinkFollow({
              rate: () => view.rate(),
              apply: async (settings) => {
                const result = await manager.configureStream(sessionId, settings);
                if (result.codec === "h264" || settings.codec !== "h264") {
                  converter.stop();
                  return result;
                }
                return converter.want(settings) ? { codec: "h264" as const } : result;
              },
            });
            try {
              // Every frame, unhurried: the viewer's window paces the pictures, not the hub.
              const stop = manager.subscribeEvery(sessionId, (frame) => {
                // Live views are video only: the stills agents read never reach a viewer, except
                // encoded as video for one whose helper makes no video of its own.
                // ace-media delivers this view on the client's media connection: none of its
                // pictures go on this socket.
                if (closed || viewer) return;
                if (frame.header.codec === "h264") view.push(framePicture(frame));
                else converter.push(frame);
              });
              follows.set(sessionId, follow);
              cancelTick ??= later(1000, tick);
              subscriptions.set(sessionId, () => {
                stop();
                if (viewer) {
                  peer.delivery?.port()?.unbind(viewer);
                  delivered.delete(sessionId);
                }
                view.close();
                follow.close();
                converter.close();
                if (follows.get(sessionId) === follow) follows.delete(sessionId);
              });
            } catch (error) {
              converter.close();
              follow.close();
              view.close();
              throw error;
            }
            peer.send({
              type: "screen.state",
              state: ScreenState.parse(manager.state(operation.sessionId)),
            });
            if (viewer && operation.media) {
              const poster = await peer.delivery?.port()?.poster(viewer);
              respond({ ok: true, media: mediaSubscribed(operation.media.connection, poster) });
              return;
            }
            break;
          }
          case "stream.configure": {
            // A view ace-media delivers is planned there at the size it asks for.
            const mediaViewer = delivered.get(operation.sessionId);
            if (mediaViewer)
              peer.delivery?.port()?.configure(
                mediaViewer,
                viewViewport({
                  width: operation.settings.maxWidth,
                  height: operation.settings.maxHeight,
                  devicePixelRatio: 1,
                }),
                false,
              );
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
