import { DeviceQueue } from "./device-queue.ts";
import { DeviceSubscriptions } from "./subscriptions.ts";
import {
  DeviceAck,
  DeviceClientMessage,
  DeviceState,
  type DeviceScreenshot,
  type DeviceServerMessage,
} from "@ace/protocol/devices";
import { streamKinds } from "@ace/browser/stream";
import {
  LinkFollow,
  PictureChannel,
  pictureLinkLimits,
  SetupPictures,
  type PictureTransport,
} from "@ace/browser/picture-channel";
import { framePicture } from "@ace/screen";
import {
  mediaSubscribed,
  viewLink,
  viewSwap,
  viewViewport,
  type HeldView,
  type MediaDeliveryPort,
} from "@ace/media/media-viewers";
import type { MediaOwner } from "@ace/media/media-connections";
import { DevicesService, deviceFailure } from "./service.ts";
import type { Actor } from "./lease.ts";
import { heldPushes } from "./held-pushes.ts";
import type { MediaAccelerationStore } from "@ace/media/acceleration";

export interface DevicePeer {
  authorize(): boolean;
  canReadThread(threadId: string): boolean;
  agentExists(threadId: string, agentId: string): boolean;
  send(message: DeviceServerMessage): Promise<void>;
  /**
   * The shared media stream (`@ace/browser/stream`): writes one binary message (a stream piece)
   * and reports the transport's backlog. Live pictures and screenshots both go here.
   */
  media: PictureTransport;
  /** Clock for keyframe pacing; defaults to the wall clock and timers. */
  now?(): number;
  after?(ms: number, run: () => void): () => void;
  /**
   * Delivery by ace-media (D1) for subscribes that name a media connection, with who this
   * connection is: its session, device and admission (a main session, or a channel of its own).
   * Without it, or while ace-media doesn't serve devices, they are served here.
   */
  delivery?: { owner: () => MediaOwner | undefined; port: () => MediaDeliveryPort | undefined };
  /** ace-media's reports of what each device's video runs on, for `DeviceState.acceleration`. */
  acceleration?: Pick<MediaAccelerationStore, "for" | "watch"> | undefined;
}
/**
 * A transport owner supplies authenticated identity and revocation checks. The channel speaks
 * at once: use it where the client has already been welcomed.
 */
export function connectDevices(service: DevicesService, owner: string, peer: DevicePeer) {
  const channel = reserveDevices(service, owner, peer);
  channel.activate();
  return channel;
}
/**
 * A devices channel opened before the socket's welcome: it subscribes now (a full subscriber
 * budget throws here, refusing the hello), but sends nothing until `activate`, called once the
 * welcome has gone out. Changes in between are held and follow the opening snapshot.
 */
export function reserveDevices(service: DevicesService, owner: string, peer: DevicePeer) {
  const actor: Actor = { kind: "human", owner, guard: () => access() };
  /** Watched devices ace-media delivers, by their view there. */
  const delivered = new Map<string, HeldView>();
  /** Each device's subscribes and unsubscribes, one at a time. */
  const queue = new DeviceQueue();
  /**
   * A subscribe naming a media connection: its viewer there, while ace-media delivers devices.
   * A connection of another session is refused.
   */
  const bindMedia = (
    deviceId: string,
    connection: string,
    operation: { link?: Parameters<typeof viewLink>[0]; codecs?: string[] | undefined },
  ): string | undefined => {
    const delivery = peer.delivery;
    const port = delivery?.port();
    const requester = delivery?.owner();
    const kinds = ["simulator", "scrcpy", "emulator-frames"] as const;
    if (!requester || !port || !kinds.some((kind) => port.serves(kind))) return undefined;
    const link = viewLink(operation.link);
    const viewer = port.bind({
      requester,
      connection,
      target: { kind: "device", deviceId },
      codecs: operation.codecs ?? ["avc1.42E033"],
      // A phone-sized pane until the viewer's `stream.configure` says its size.
      viewport: viewViewport({ width: 390, height: 844, devicePixelRatio: 3 }),
      local: false,
      audio: false,
      ...(link ? { link } : {}),
      shows: (producer) => producer.deviceId === deviceId,
    });
    if (viewer === undefined)
      throw new Error("media-connection: that media connection isn't this session's");
    return viewer;
  };
  const streams = new DeviceSubscriptions();
  const logs = new DeviceSubscriptions();
  const pictures = new PictureChannel(streamKinds.deviceFrame, {
    transport: peer.media,
    now: peer.now ?? (() => performance.now()),
    after:
      peer.after ??
      ((ms: number, run: () => void) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      }),
    failed: () => close(),
  });
  let closed = false;
  let pending = 0;
  /** Each watched device's stream request, kept within this viewer's link. */
  const follows = new Map<string, LinkFollow>();
  const later =
    peer.after ??
    ((ms: number, run: () => void) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  let cancelTick: (() => void) | undefined;
  const tick = () => {
    for (const follow of follows.values()) follow.tick();
    cancelTick = follows.size ? later(1000, tick) : undefined;
  };
  const access = () => {
    if (closed || !peer.authorize()) throw new Error("Device access revoked");
  };
  const deviceAccess = (id: string) => {
    access();
    const thread = service.boundThread(id);
    if (thread && !peer.canReadThread(thread)) throw new Error("Device thread access denied");
  };
  const pushes = heldPushes(async (message) => {
    access();
    await peer.send(message);
  });
  const send = async (message: DeviceServerMessage) => {
    access();
    await pushes.send(message);
  };
  const stateForPeer = (state: DeviceState): DeviceState => {
    const acceleration = peer.acceleration?.for("deviceId", state.device.id);
    return {
      ...state,
      ownedHere: service.ownsControl(state.device.id, owner),
      ...(acceleration ? { acceleration } : {}),
    };
  };
  const unwatch = service.watch((state) => {
    if (state.threadId && !peer.canReadThread(state.threadId)) return;
    void send({ type: "devices.state", state: stateForPeer(state) }).catch(close);
  });
  const unwatchAcceleration = peer.acceleration?.watch((change) => {
    const id = change.kind === "source" ? change.subject.deviceId : undefined;
    const state = id === undefined ? undefined : service.states().find((s) => s.device.id === id);
    if (closed || !state || (state.threadId && !peer.canReadThread(state.threadId))) return;
    void send({ type: "devices.state", state: stateForPeer(state) }).catch(close);
  });
  // Admin peers see the whole inventory, as a "list" request would show them.
  const unwatchInventory = service.watchInventory((inventory) => {
    void send({ type: "devices.inventory", ...inventory }).catch(close);
  });
  // Turning devices on or off reaches every view, including ones with no device sessions.
  const unwatchEnabled = service.watchEnabled((enabled) => {
    void send({ type: "devices.enabled", enabled }).catch(close);
  });
  /** Held while this connection's client says a Devices view is open. */
  let inventoryView: (() => void) | undefined;
  function close() {
    if (closed) return;
    closed = true;
    cancelTick?.();
    cancelTick = undefined;
    for (const follow of follows.values()) follow.close();
    follows.clear();
    pictures.close();
    unwatch();
    unwatchInventory();
    unwatchEnabled();
    unwatchAcceleration?.();
    inventoryView?.();
    inventoryView = undefined;
    streams.close();
    logs.close();
    service.disconnect(owner);
  }
  return {
    close,
    /**
     * The client has been welcomed: tell it whether devices are on, then anything that changed
     * since this channel subscribed. A view that just connected, or reconnected after missing a
     * change, needs the current value: with devices on by default, turning them on may change
     * nothing and so announce nothing.
     */
    activate(): void {
      if (closed) return;
      void pushes.open([{ type: "devices.enabled", enabled: service.isEnabled() }]).catch(close);
    },
    /** A viewer's `devices.ack`: frees its window, or asks for a keyframe. Never answered. */
    ack(raw: unknown): void {
      const message = DeviceAck.parse(raw);
      access();
      pictures.ack(message.deviceId, message.streamId, message.sequence, message.keyframe);
    },
    async request(raw: unknown): Promise<void> {
      const message = DeviceClientMessage.parse(raw);
      try {
        access();
        if (pending >= 32) throw new Error("Too many pending device requests");
        const operation = message.operation;
        if (
          "threadId" in operation &&
          operation.threadId &&
          !peer.canReadThread(operation.threadId)
        )
          throw new Error("Thread access denied");
        if (
          operation.op === "controller" &&
          operation.controller === "agent" &&
          (!operation.threadId ||
            !operation.agentId ||
            !peer.agentExists(operation.threadId, operation.agentId))
        )
          throw new Error("Unknown device agent");
        if ("deviceId" in operation) {
          deviceAccess(operation.deviceId);
        }
        pending++;
        try {
          let requestActor = actor;
          /** A subscribe's answer, made while it was set up. */
          let subscribed:
            | { state: DeviceState; media?: ReturnType<typeof mediaSubscribed> }
            | undefined;
          if (operation.op === "subscribe") {
            const deviceId = operation.deviceId;
            // One at a time per device, the latest winning (`DeviceQueue`): this setup and its
            // rollback only ever meet the committed subscription. That one keeps delivering
            // until this one is set up, and a failed resubscribe leaves it as it was, its view
            // in ace-media included (`viewSwap`).
            await queue.run(deviceId, "subscribe", async (superseded) => {
              const slot = streams.reserve(deviceId);
              const port = peer.delivery?.port();
              let granted: HeldView | undefined;
              let stop: (() => void) | undefined;
              let committed = false;
              /** The subscription may still see the device. */
              const live = () => {
                deviceAccess(deviceId);
                if (!slot.active()) throw new Error("Device subscription superseded");
              };
              /** Its setup may go on: nothing newer came for the device. */
              const setup = () => {
                live();
                if (superseded()) throw new Error("Device subscription superseded");
              };
              try {
                const connection = operation.media?.connection;
                const viewer =
                  connection === undefined ? undefined : bindMedia(deviceId, connection, operation);
                granted =
                  viewer !== undefined && connection !== undefined
                    ? { viewer, connection }
                    : undefined;
                /** This view's pictures, opened once it is set up (opening replaces the old one's). */
                const early = new SetupPictures();
                // Every frame, unhurried: the viewer's window paces the pictures, not the hub.
                stop = await service.subscribeEvery(deviceId, actor, (frame) => {
                  live();
                  // Live views are video only: the JPEG a capture makes for agents while nobody
                  // watches (until this view's H.264 starts) never reaches one. ace-media
                  // delivers this view on the client's media connection.
                  if (frame.header.codec !== "h264" || viewer) return;
                  early.push(framePicture(frame));
                });
                setup();
                const state = stateForPeer(
                  DeviceState.parse(await service.request(operation, requestActor)),
                );
                setup();
                const poster = viewer ? await port?.poster(viewer) : undefined;
                setup();
                // Set up: the new view replaces the old one.
                viewSwap(port, delivered.get(deviceId), granted).commit();
                committed = true;
                if (granted) delivered.set(deviceId, granted);
                else delivered.delete(deviceId);
                const keyframe = () =>
                  void service.request({ op: "stream.keyframe", deviceId }, actor).catch(() => {});
                const opened = pictures.open(deviceId, {
                  keyframe,
                  guard: live,
                  link: pictureLinkLimits,
                  ...(operation.link ? { hint: operation.link } : {}),
                });
                // The keyframe the capture made for this view during setup comes first.
                early.open(opened, keyframe);
                const follow = new LinkFollow({
                  link: () => opened.link(),
                  now: peer.now ?? (() => performance.now()),
                  apply: (settings) =>
                    service.request({ op: "stream.configure", deviceId, settings }, actor),
                });
                follows.get(deviceId)?.close();
                follows.set(deviceId, follow);
                cancelTick ??= later(1000, tick);
                const held = granted;
                const ending = stop;
                slot.attach(() => {
                  ending();
                  // Its view in ace-media goes with it, unless a newer subscribe took the device.
                  if (held && delivered.get(deviceId) === held) {
                    delivered.delete(deviceId);
                    port?.unbind(held.viewer);
                  }
                  opened.close();
                  follow.close();
                  if (follows.get(deviceId) === follow) follows.delete(deviceId);
                });
                subscribed = {
                  state,
                  ...(granted ? { media: mediaSubscribed(granted.connection, poster) } : {}),
                };
              } catch (error) {
                stop?.();
                slot.cancel();
                // Past the commit only a closing connection throws: it ends every view itself.
                if (!committed) viewSwap(port, delivered.get(deviceId), granted).abort();
                throw error;
              }
            });
          } else if (operation.op === "unsubscribe") {
            const deviceId = operation.deviceId;
            await queue.run(deviceId, "unsubscribe", async () => streams.remove(deviceId));
          }
          if (operation.op === "logs.start") {
            // A new log subscription replaces the old one at once: no batch goes out twice.
            logs.remove(operation.deviceId);
            const slot = logs.reserve(operation.deviceId);
            const guard = () => {
              deviceAccess(operation.deviceId);
              if (!slot.active()) throw new Error("Device log subscription superseded");
            };
            requestActor = { ...actor, guard };
            try {
              slot.attach(
                await service.subscribeLogs(operation.deviceId, requestActor, async (batch) => {
                  guard();
                  await send({ type: "devices.logs", deviceId: operation.deviceId, ...batch });
                }),
              );
            } catch (error) {
              slot.cancel();
              throw error;
            }
          } else if (operation.op === "logs.stop") {
            logs.remove(operation.deviceId);
          }
          if (operation.op === "inventory.watch") {
            if (!operation.watching) {
              inventoryView?.();
              inventoryView = undefined;
              await service.settleInventory();
            } else inventoryView ??= service.holdInventoryView();
          }
          const follow =
            operation.op === "stream.configure" ? follows.get(operation.deviceId) : undefined;
          const data =
            operation.op === "inventory.watch"
              ? { watching: inventoryView !== undefined }
              : operation.op === "screenshot" || subscribed
                ? undefined
                : follow && operation.op === "stream.configure"
                  ? // The view's request, with its bit rate held to what its link carries.
                    await follow.ask(operation.settings)
                  : await service.request(operation, requestActor);
          access();
          if ("deviceId" in operation) deviceAccess(operation.deviceId);
          if (subscribed) {
            await send({
              type: "devices.result",
              requestId: message.requestId,
              ok: true,
              data: subscribed.state,
              ...(subscribed.media ? { media: subscribed.media } : {}),
            });
          } else if (operation.op === "screenshot") {
            // The picture goes first as a still on the media stream; the result names it.
            const picture = framePicture(await service.screenshot(operation.deviceId, actor));
            await pictures.still(operation.deviceId, picture, () =>
              deviceAccess(operation.deviceId),
            );
            const shot: DeviceScreenshot = {
              streamId: picture.streamId,
              sequence: picture.sequence,
              width: picture.width,
              height: picture.height,
              bytes: picture.bytes.length,
            };
            await send({
              type: "devices.result",
              requestId: message.requestId,
              ok: true,
              data: shot,
            });
          } else {
            const result =
              operation.op === "states"
                ? {
                    states: service
                      .states()
                      .filter((state) => !state.threadId || peer.canReadThread(state.threadId))
                      .map(stateForPeer),
                    enabled: service.isEnabled(),
                  }
                : ["controller", "start", "stop", "unsubscribe"].includes(operation.op)
                  ? stateForPeer(DeviceState.parse(data))
                  : data;
            await send({
              type: "devices.result",
              requestId: message.requestId,
              ok: true,
              data: result,
            });
          }
        } finally {
          pending--;
        }
      } catch (error) {
        if (!closed && peer.authorize())
          await send({
            type: "devices.result",
            requestId: message.requestId,
            ok: false,
            error: deviceFailure(error),
          });
      }
    },
  };
}
