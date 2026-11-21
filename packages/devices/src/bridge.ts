import { DeviceQueue } from "./device-queue.ts";
import { DeviceSubscriptions } from "./subscriptions.ts";
import {
  AppDeviceId,
  DeviceAck,
  DeviceClientMessage,
  DeviceState,
  type DeviceScreenshot,
  type DeviceServerMessage,
} from "@ace/protocol/devices";
import { framePicture } from "@ace/screen";
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
import { DevicesService, deviceFailure } from "./service.ts";
import type { Actor } from "./lease.ts";
import { heldPushes } from "./held-pushes.ts";
import type { MediaAccelerationStore } from "@ace/media/acceleration";
import { StillWriter, type StillTransport } from "./still-writer.ts";

/** The ace-media sources that show a device. */
const showsDevice = (deviceId: string) => (producer: { deviceId?: string | undefined }) =>
  producer.deviceId === deviceId;

/** Why a device's view gets no pictures: the reason for its own source's kind. */
function deviceUndelivered(
  deviceId: string,
  named: boolean,
  port: MediaDeliveryPort | undefined,
): ReturnType<typeof mediaUndelivered> {
  const kinds = port?.sourceKinds(showsDevice(deviceId)) ?? [];
  if (named && port && !kinds.length)
    return {
      code: "unavailable",
      reason: "Live video starts once the device's screen is running.",
    };
  return mediaUndelivered(named, port, kinds);
}

export interface DevicePeer {
  authorize(): boolean;
  canReadThread(threadId: string): boolean;
  agentExists(threadId: string, agentId: string): boolean;
  send(message: DeviceServerMessage): Promise<void>;
  /**
   * The connection's binary stream (`@ace/browser/stream`): writes one binary message (a stream
   * piece) and reports the transport's backlog. Only a person's screenshots go here; live
   * pictures come from ace-media on the client's media connection (X3).
   */
  media: StillTransport;
  /**
   * Delivery by ace-media (D1) for subscribes that name a media connection, with who this
   * connection is: its session, device and admission (a main session, or a channel of its own).
   * Nothing else delivers a device's pictures: without it, or while ace-media doesn't serve
   * devices, a subscribe's reply says why (`undelivered`).
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
    // The device's own source: a kind ace-media serves for another device is no help here.
    const kinds = port?.sourceKinds(showsDevice(deviceId)) ?? [];
    if (!requester || !port || !kinds.length || !kinds.every((kind) => port.serves(kind)))
      return undefined;
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
      shows: showsDevice(deviceId),
      onGrant: (granted, refused) => tellDelivery(deviceId, granted, refused),
    });
    if (viewer === undefined)
      throw new Error("media-connection: that media connection isn't this session's");
    return viewer;
  };
  /**
   * Tells this connection whether its bound view of the device gets pictures now: on every
   * change of the view's grant in ace-media, with the reason while it doesn't.
   */
  const tellDelivery = (deviceId: string, granted: boolean, refused?: string) => {
    // Only a subscriber that asked reads it: an older decoder refuses an unknown message type.
    if (closed || !status.has(deviceId)) return;
    const port = peer.delivery?.port();
    const kinds = port?.sourceKinds(showsDevice(deviceId)) ?? [];
    const undelivered = granted
      ? undefined
      : pendingUndelivered(
          port?.sourceState(showsDevice(deviceId)) ?? "pending",
          kinds.map((kind) => port?.unserved(kind)).find((reason) => reason !== undefined),
          refused,
        );
    void send({
      type: "devices.delivery",
      deviceId: AppDeviceId.parse(deviceId),
      ...(undelivered ? { undelivered } : {}),
    }).catch(() => {});
  };
  const streams = new DeviceSubscriptions();
  const logs = new DeviceSubscriptions();
  const stills = new StillWriter(peer.media);
  let closed = false;
  let pending = 0;
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
  /** Devices this connection watches from a client older than X3 (no `mediaClient`). */
  const old = new Set<string>();
  /** Devices whose subscriber reads `devices.delivery` (`deliveryStatus`): only they get one. */
  const status = new Set<string>();
  /**
   * A device's state as this connection sees it; for an older client, with why its view is
   * empty in the field it already shows (`error`), unless the device has a failure of its own.
   */
  const stateForPeer = (state: DeviceState): DeviceState => {
    const acceleration = peer.acceleration?.for("deviceId", state.device.id);
    const told =
      old.has(state.device.id) && !state.error
        ? {
            error: {
              code: "not_supported" as const,
              message: updateReason,
              hint: "Update ace on this device.",
            },
          }
        : {};
    return {
      ...state,
      ownedHere: service.ownsControl(state.device.id, owner),
      ...(acceleration ? { acceleration } : {}),
      ...told,
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
    stills.close();
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
    /** Acks go on the media connection now: the daemon sends no pictures to ack here. */
    ack(raw: unknown): void {
      DeviceAck.parse(raw);
      access();
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
            | {
                state: DeviceState;
                media?: ReturnType<typeof mediaSubscribed>;
                undelivered?: ReturnType<typeof mediaUndelivered>;
              }
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
                if (operation.mediaClient === true) old.delete(deviceId);
                else old.add(deviceId);
                if (operation.deliveryStatus === true) status.add(deviceId);
                else status.delete(deviceId);
                const connection = operation.media?.connection;
                const viewer =
                  connection === undefined ? undefined : bindMedia(deviceId, connection, operation);
                granted =
                  viewer !== undefined && connection !== undefined
                    ? { viewer, connection }
                    : undefined;
                // ace-media delivers the view on the client's media connection: the capture runs
                // while it is held, and none of its pictures go on this socket. A view it doesn't
                // deliver holds it too, so a device that can't stream says why to every client.
                stop = await service.subscribeEvery(deviceId, actor, () => live());
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
                const held = granted;
                const ending = stop;
                slot.attach(() => {
                  ending();
                  // Its view in ace-media goes with it, unless a newer subscribe took the device.
                  if (held && delivered.get(deviceId) === held) {
                    delivered.delete(deviceId);
                    port?.unbind(held.viewer);
                  }
                });
                subscribed = {
                  state,
                  ...(granted
                    ? { media: mediaSubscribed(granted.connection, poster) }
                    : {
                        // No pictures will come: the view says why instead of staying blank.
                        undelivered: deviceUndelivered(
                          deviceId,
                          operation.media !== undefined,
                          port,
                        ),
                      }),
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
            old.delete(deviceId);
            status.delete(deviceId);
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
          const data =
            operation.op === "inventory.watch"
              ? { watching: inventoryView !== undefined }
              : operation.op === "screenshot" || subscribed
                ? undefined
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
              ...(subscribed.undelivered ? { undelivered: subscribed.undelivered } : {}),
            });
            // Bound, but the device isn't streaming into ace-media yet: say why until it does.
            const watched = "deviceId" in operation ? operation.deviceId : undefined;
            const viewer = subscribed.media && watched && delivered.get(watched)?.viewer;
            if (watched && viewer && !peer.delivery?.port()?.granted(viewer))
              tellDelivery(watched, false);
          } else if (operation.op === "screenshot") {
            // The picture goes first as a still on this connection; the result names it.
            const picture = framePicture(await service.screenshot(operation.deviceId, actor));
            await stills.write(operation.deviceId, picture, () => deviceAccess(operation.deviceId));
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
