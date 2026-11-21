import { TargetBusyError } from "./target-busy.ts";
import {
  ScreenAck,
  ScreenError,
  ScreenClientMessage,
  ScreenState,
  type ScreenServerMessage,
} from "@ace/protocol";
import {
  mediaSubscribed,
  mediaUndelivered,
  pendingUndelivered,
  updateReason,
  viewLink,
  viewSwap,
  viewViewport,
  type HeldView,
  type MediaDeliveryPort,
} from "@ace/media/media-viewers";
import type { MediaOwner } from "@ace/media/media-connections";
import type { MediaAccelerationStore } from "@ace/media/acceleration";
import type { ScreenManager } from "./manager.ts";
import type { Simulators } from "./simulator.ts";

/** The ace-media sources that show a screen session. */
const showsSession =
  (sessionId: string) => (producer: { kind: string; sessionId?: string | undefined }) =>
    producer.kind === "screen" && producer.sessionId === sessionId;

export type ScreenPeer = {
  send: (message: ScreenServerMessage) => void;
  /**
   * Delivery by ace-media (D1) for subscribes that name a media connection, with who this
   * connection is: its session, device and admission (a main session, or a channel of its own).
   * Nothing else delivers a session's pictures (X3): without it, or while ace-media doesn't serve
   * screens, a subscribe's reply says why (`undelivered`).
   */
  delivery?: { owner: () => MediaOwner | undefined; port: () => MediaDeliveryPort | undefined };
  /** ace-media's reports of what each session's video runs on, for `ScreenState.acceleration`. */
  acceleration?: Pick<MediaAccelerationStore, "for" | "watch"> | undefined;
};
/**
 * Attach only after the host transport authenticates a human device. A subscribed session's
 * pictures come from ace-media on the client's media connection, never on this one.
 */
export function screenConnection(
  manager: ScreenManager,
  simulators: Simulators,
  owner: string,
  peer: ScreenPeer,
): { request(input: unknown): Promise<void>; ack(input: unknown): void; close(): void } {
  /** Each watched session's view: what to release, and its view in ace-media if it has one. */
  const subscriptions = new Map<string, { media: HeldView | undefined; release(): void }>();
  /** A watched session's view ends: everything it holds, its view in ace-media included. */
  const end = (sessionId: string) => {
    const watch = subscriptions.get(sessionId);
    if (!watch) return;
    subscriptions.delete(sessionId);
    old.delete(sessionId);
    status.delete(sessionId);
    watch.release();
    if (watch.media) peer.delivery?.port()?.unbind(watch.media.viewer);
  };
  let closed = false;
  let pending = 0;
  /** Sessions this connection watches from a client older than X3 (no `mediaClient`). */
  const old = new Set<string>();
  /** Sessions whose subscriber reads `screen.delivery` (`deliveryStatus`): only they get one. */
  const status = new Set<string>();
  /**
   * A session's state as this connection sees it: with what its video runs on and, for an older
   * client, why its view is empty in the field it already shows (`error`).
   */
  const accelerated = (state: ScreenState): ScreenState => {
    const acceleration = peer.acceleration?.for("sessionId", state.sessionId);
    const told = old.has(state.sessionId) ? { ...state, error: updateReason } : state;
    return acceleration ? { ...told, acceleration } : told;
  };
  const unwatch = manager.watch((state) => {
    if (!closed) peer.send({ type: "screen.state", state: accelerated(state) });
  });
  const unwatchAcceleration = peer.acceleration?.watch((change) => {
    const id = change.kind === "source" ? change.subject.sessionId : undefined;
    if (closed || id === undefined) return;
    let state: ScreenState;
    try {
      state = ScreenState.parse(manager.state(id));
    } catch {
      return; // The session is gone; its last state said so.
    }
    peer.send({ type: "screen.state", state: accelerated(state) });
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
    const link = viewLink(operation.link);
    const viewer = port.bind({
      requester,
      connection,
      target: { kind: "screen", sessionId },
      codecs: operation.codecs ?? ["avc1.42E033"],
      // The viewer says its size with `stream.configure`; until then, a desktop pane.
      viewport: viewViewport({ width: 1280, height: 800, devicePixelRatio: 2 }),
      local: false,
      audio: false,
      ...(link ? { link } : {}),
      shows: showsSession(sessionId),
      onGrant: (granted, refused) => delivered(sessionId, granted, refused),
    });
    if (viewer === undefined)
      throw new Error("media-connection: that media connection isn't this session's");
    return viewer;
  };
  /**
   * Tells this connection whether its bound view of the session gets pictures now: on every
   * change of the view's grant in ace-media, with the reason while it doesn't.
   */
  const delivered = (sessionId: string, granted: boolean, refused?: string) => {
    // Only a subscriber that asked reads it: an older decoder refuses an unknown message type.
    if (closed || !status.has(sessionId)) return;
    const port = peer.delivery?.port();
    const undelivered = granted
      ? undefined
      : pendingUndelivered(
          port?.sourceState(showsSession(sessionId)) ?? "pending",
          port?.unserved("screen"),
          refused,
        );
    peer.send({ type: "screen.delivery", sessionId, ...(undelivered ? { undelivered } : {}) });
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
            const sessionId = operation.sessionId;
            // The session's earlier view keeps delivering until this one is set up: a failed
            // resubscribe leaves it as it was (ace-media's view included, through `viewSwap`).
            const previous = subscriptions.get(sessionId);
            if (!previous && subscriptions.size >= 8) throw new Error("Screen subscription limit");
            const connection = operation.media?.connection;
            const viewer =
              connection === undefined ? undefined : bindMedia(sessionId, connection, operation);
            const media =
              viewer !== undefined && connection !== undefined ? { viewer, connection } : undefined;
            const swap = viewSwap(peer.delivery?.port(), previous?.media, media);
            if (operation.mediaClient === true) old.delete(sessionId);
            else old.add(sessionId);
            if (operation.deliveryStatus === true) status.add(sessionId);
            else status.delete(sessionId);
            let stop: (() => void) | undefined;
            let state: ScreenState;
            try {
              // ace-media delivers the view on the client's media connection: the capture runs
              // while it is held, and none of its pictures go on this socket. A view it doesn't
              // deliver holds it too, so the session looks and acts the same to every client.
              stop = manager.subscribeEvery(sessionId, () => {});
              state = accelerated(ScreenState.parse(manager.state(sessionId)));
            } catch (error) {
              stop?.();
              swap.abort();
              throw error;
            }
            // Set up: the new view replaces the old one.
            swap.commit();
            subscriptions.delete(sessionId);
            previous?.release();
            subscriptions.set(sessionId, { media, release: () => stop?.() });
            peer.send({ type: "screen.state", state });
            if (viewer && operation.media) {
              const poster = await peer.delivery?.port()?.poster(viewer);
              respond({ ok: true, media: mediaSubscribed(operation.media.connection, poster) });
              // Bound, but the session isn't streaming into ace-media yet: say why until it does.
              if (!peer.delivery?.port()?.granted(viewer)) delivered(sessionId, false);
              return;
            }
            // No pictures will come: the view says why instead of staying blank.
            respond({
              ok: true,
              undelivered: mediaUndelivered(operation.media !== undefined, peer.delivery?.port(), [
                "screen",
              ]),
            });
            return;
          }
          case "stream.configure": {
            // A view ace-media delivers is planned there at the size it asks for.
            const mediaViewer = subscriptions.get(operation.sessionId)?.media?.viewer;
            if (mediaViewer) {
              peer.delivery?.port()?.configure(
                mediaViewer,
                viewViewport({
                  width: operation.settings.maxWidth,
                  height: operation.settings.maxHeight,
                  devicePixelRatio: 1,
                }),
                false,
              );
              // The helper runs ace-media's plan for that view (`source.want`): this request
              // only resizes the view there, never reconfiguring the helper against it.
              data = { codec: operation.settings.codec };
              break;
            }
            data = await manager.configureStream(operation.sessionId, operation.settings);
            break;
          }
          case "unsubscribe":
            end(operation.sessionId);
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
    /** Acks go on the media connection now: the daemon sends no pictures to ack here. */
    ack(input) {
      ScreenAck.parse(input);
    },
    close() {
      closed = true;
      for (const sessionId of subscriptions.keys()) end(sessionId);
      unwatch();
      unwatchAcceleration?.();
      unwatchEnabled();
      manager.releaseController(owner);
    },
  };
}
