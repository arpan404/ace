import { DeviceSubscriptions } from "./subscriptions.ts";
import { DeviceFrameWriter } from "./frame-writer.ts";
import {
  DeviceAck,
  DeviceClientMessage,
  DeviceState,
  type DeviceServerMessage,
} from "@ace/protocol/devices";
import { DeviceMediaViewer } from "./media-viewer.ts";
import type { Frame } from "@ace/screen";
import { DevicesService, deviceFailure } from "./service.ts";
import type { Actor } from "./lease.ts";

export interface DevicePeer {
  authorize(): boolean;
  canReadThread(threadId: string): boolean;
  agentExists(threadId: string, agentId: string): boolean;
  send(message: DeviceServerMessage): Promise<void>;
  frame(packet: Buffer): Promise<void>;
  /** Reliable screenshot: resolve only after bytes are sent, or reject explicitly. */
  image(packet: Buffer): Promise<void>;
  /**
   * The shared media stream (`@ace/browser/stream`): writes one binary message (a stream piece)
   * and reports the transport's backlog. Absent: this peer only gets screen packets.
   */
  media?: {
    write(piece: Uint8Array): Promise<void>;
    bufferedBytes(): number;
  };
  /** Clock for keyframe pacing; defaults to the wall clock and timers. */
  now?(): number;
  after?(ms: number, run: () => void): () => void;
}
/**
 * A media viewer stops taking pictures while the transport holds more than this, as screen
 * packets do: control messages on the same channel must never find it backed up (the relay
 * closes a channel whose control replies can't get out).
 */
const mediaBacklogBytes = 128 * 1024;
/** A transport owner supplies authenticated identity and revocation checks. */
export function connectDevices(service: DevicesService, owner: string, peer: DevicePeer) {
  const frames = new DeviceFrameWriter(peer.frame);
  const actor: Actor = { kind: "human", owner, guard: () => access() };
  const streams = new DeviceSubscriptions();
  const logs = new DeviceSubscriptions();
  /** Devices this connection watches on the shared media stream, by device id. */
  const viewers = new Map<string, DeviceMediaViewer>();
  let messageIds = 0;
  let retry: (() => void) | undefined;
  const after =
    peer.after ??
    ((ms: number, run: () => void) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  const flushViewers = () => {
    for (const viewer of viewers.values()) viewer.flush();
  };
  const mediaViewer = (deviceId: string, guard: () => void) => {
    const media = peer.media;
    if (!media) throw new Error("This connection has no media stream");
    return new DeviceMediaViewer(deviceId, {
      messageId: () => (messageIds = (messageIds + 1) >>> 0),
      now: peer.now ?? (() => performance.now()),
      after,
      keyframe: () =>
        void service.request({ op: "stream.keyframe", deviceId }, actor).catch(() => {}),
      write: (pieces) => {
        if (frames.pending >= 4 || media.bufferedBytes() > mediaBacklogBytes) {
          // The socket drains on its own; look again shortly unless a write will report it.
          if (!frames.pending && !retry && !closed)
            retry = after(50, () => {
              retry = undefined;
              flushViewers();
            });
          return false;
        }
        void frames
          .run(async () => {
            for (const piece of pieces) await media.write(piece);
          }, guard)
          .then(flushViewers, close);
        return true;
      },
    });
  };
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
    frames.close();
    retry?.();
    for (const viewer of viewers.values()) viewer.close();
    viewers.clear();
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
      viewers.get(message.deviceId)?.ack(message.streamId, message.sequence, message.keyframe);
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
              if (operation.mediaStream && peer.media) {
                const viewer = mediaViewer(operation.deviceId, guard);
                viewers.get(operation.deviceId)?.close();
                viewers.set(operation.deviceId, viewer);
                const release = () => {
                  viewer.close();
                  if (viewers.get(operation.deviceId) === viewer)
                    viewers.delete(operation.deviceId);
                };
                try {
                  // Every frame, unhurried: the viewer's window paces the pictures, not the hub.
                  const stop = await service.subscribeEvery(operation.deviceId, actor, (frame) => {
                    guard();
                    viewer.push(frame);
                  });
                  slot.attach(() => {
                    stop();
                    release();
                  });
                } catch (error) {
                  release();
                  throw error;
                }
              } else
                slot.attach(
                  await service.subscribe(operation.deviceId, actor, async (frame) => {
                    guard();
                    await frames.send(frame.packet, guard);
                  }),
                );
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
          const data =
            operation.op === "inventory.watch"
              ? { watching: inventoryView !== undefined }
              : operation.op === "screenshot"
                ? undefined
                : await service.request(operation, requestActor);
          access();
          if ("deviceId" in operation) deviceAccess(operation.deviceId);
          if (operation.op === "screenshot") {
            // Image bytes always use the screen binary protocol; JSON is metadata only.
            const frame = await service.screenshot(operation.deviceId, actor);
            await frames.send(frame.packet, () => deviceAccess(operation.deviceId), peer.image);
            await send({
              type: "devices.result",
              requestId: message.requestId,
              ok: true,
              data: frame.header,
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
/** Screen packets are byte streams over the relay, whose records are smaller than images. */
export async function sendDeviceFrame(
  packet: Frame["packet"],
  send: (bytes: Uint8Array) => Promise<void>,
  authorize: () => boolean,
): Promise<void> {
  for (let offset = 0; offset < packet.length; offset += 64 * 1024) {
    if (!authorize()) throw new Error("Device stream access revoked");
    await send(packet.subarray(offset, offset + 64 * 1024));
  }
}
