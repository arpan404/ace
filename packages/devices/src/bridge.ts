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
  type PictureTransport,
} from "@ace/browser/picture-channel";
import { framePicture } from "@ace/screen";
import { DevicesService, deviceFailure } from "./service.ts";
import type { Actor } from "./lease.ts";

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
}
/** A transport owner supplies authenticated identity and revocation checks. */
export function connectDevices(service: DevicesService, owner: string, peer: DevicePeer) {
  const actor: Actor = { kind: "human", owner, guard: () => access() };
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
  const send = async (message: DeviceServerMessage) => {
    access();
    await peer.send(message);
  };
  const stateForPeer = (state: DeviceState): DeviceState => ({
    ...state,
    ownedHere: service.ownsControl(state.device.id, owner),
  });
  const unwatch = service.watch((state) => {
    if (state.threadId && !peer.canReadThread(state.threadId)) return;
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
    inventoryView?.();
    inventoryView = undefined;
    streams.close();
    logs.close();
    service.disconnect(owner);
  }
  return {
    close,
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
          if (operation.op === "subscribe") {
            const slot = streams.reserve(operation.deviceId);
            try {
              const guard = () => {
                deviceAccess(operation.deviceId);
                if (!slot.active()) throw new Error("Device subscription superseded");
              };
              const deviceId = operation.deviceId;
              const view = pictures.open(deviceId, {
                keyframe: () =>
                  void service.request({ op: "stream.keyframe", deviceId }, actor).catch(() => {}),
                guard,
                link: pictureLinkLimits,
              });
              const follow = new LinkFollow({
                rate: () => view.rate(),
                apply: (settings) =>
                  service.request({ op: "stream.configure", deviceId, settings }, actor),
              });
              try {
                // Every frame, unhurried: the viewer's window paces the pictures, not the hub.
                const stop = await service.subscribeEvery(deviceId, actor, (frame) => {
                  guard();
                  // Live views are video only: the JPEG a capture makes for agents while
                  // nobody watches (until this view's H.264 starts) never reaches one.
                  if (frame.header.codec !== "h264") return;
                  view.push(framePicture(frame));
                });
                follows.get(deviceId)?.close();
                follows.set(deviceId, follow);
                cancelTick ??= later(1000, tick);
                slot.attach(() => {
                  stop();
                  view.close();
                  follow.close();
                  if (follows.get(deviceId) === follow) follows.delete(deviceId);
                });
              } catch (error) {
                view.close();
                throw error;
              }
            } catch (error) {
              slot.cancel();
              throw error;
            }
          } else if (operation.op === "unsubscribe") {
            streams.remove(operation.deviceId);
          }
          if (operation.op === "logs.start") {
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
              : operation.op === "screenshot"
                ? undefined
                : follow && operation.op === "stream.configure"
                  ? // The view's request, with its bit rate held to what its link carries.
                    await follow.ask(operation.settings)
                  : await service.request(operation, requestActor);
          access();
          if ("deviceId" in operation) deviceAccess(operation.deviceId);
          if (operation.op === "screenshot") {
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
                : ["controller", "start", "stop", "subscribe", "unsubscribe"].includes(operation.op)
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
