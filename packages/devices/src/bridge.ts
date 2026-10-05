import { DeviceSubscriptions } from "./subscriptions.ts";
import { DeviceFrameWriter } from "./frame-writer.ts";
import { DeviceClientMessage, type DeviceServerMessage } from "@ace/protocol/devices";
import type { Frame } from "@ace/screen";
import { DevicesService, deviceFailure } from "./service.ts";
import type { Actor } from "./lease.ts";

export interface DevicePeer {
  authorize(): boolean;
  canReadThread(threadId: string): boolean;
  agentExists(threadId: string, agentId: string): boolean;
  send(message: DeviceServerMessage): Promise<void>;
  frame(packet: Buffer): Promise<void>;
}
/** A transport owner supplies authenticated identity and revocation checks. */
export function connectDevices(service: DevicesService, owner: string, peer: DevicePeer) {
  const frames = new DeviceFrameWriter(peer.frame);
  const actor: Actor = { kind: "human", owner };
  const streams = new DeviceSubscriptions();
  const logs = new DeviceSubscriptions();
  let closed = false;
  let pending = 0;
  const access = () => {
    if (closed || !peer.authorize()) throw new Error("Device access revoked");
  };
  const deviceAccess = (id: string) => {
    access();
    const thread = service.approvedThread(id);
    if (thread && !peer.canReadThread(thread)) throw new Error("Device thread access denied");
  };
  const send = async (message: DeviceServerMessage) => {
    access();
    await peer.send(message);
  };
  const unwatch = service.watch((state) => {
    if (state.threadId && !peer.canReadThread(state.threadId)) return;
    void send({ type: "devices.state", state }).catch(close);
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
          if (operation.op === "subscribe") {
            const slot = streams.reserve(operation.deviceId);
            try {
              const guard = () => {
                deviceAccess(operation.deviceId);
                if (!slot.active()) throw new Error("Device subscription superseded");
              };
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
            try {
              slot.attach(
                await service.subscribeLogs(operation.deviceId, actor, async (batch) => {
                  deviceAccess(operation.deviceId);
                  if (!slot.active()) throw new Error("Device log subscription superseded");
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
                : await service.request(operation, actor);
          access();
          if ("deviceId" in operation) deviceAccess(operation.deviceId);
          if (operation.op === "screenshot") {
            // Image bytes always use the screen binary protocol; JSON is metadata only.
            const frame = await service.screenshot(operation.deviceId, actor);
            await frames.send(frame.packet, () => deviceAccess(operation.deviceId));
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
                      .filter((state) => !state.threadId || peer.canReadThread(state.threadId)),
                    enabled: service.isEnabled(),
                  }
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
