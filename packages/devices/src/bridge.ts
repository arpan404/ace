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
  const streams = new Map<string, () => void>();
  const logs = new Map<string, () => void>();
  let closed = false;
  let pending = 0;
  const access = () => {
    if (closed || !peer.authorize()) throw new Error("Device access revoked");
  };
  const send = async (message: DeviceServerMessage) => {
    access();
    await peer.send(message);
  };
  const unwatch = service.watch((state) => {
    if (state.threadId && !peer.canReadThread(state.threadId)) return;
    void send({ type: "devices.state", state }).catch(close);
  });
  function close() {
    if (closed) return;
    closed = true;
    frames.close();
    unwatch();
    for (const release of streams.values()) release();
    for (const release of logs.values()) release();
    streams.clear();
    logs.clear();
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
          const state = service.states().find((entry) => entry.device.id === operation.deviceId);
          if (state?.threadId && !peer.canReadThread(state.threadId))
            throw new Error("Device thread access denied");
        }
        pending++;
        try {
          if (operation.op === "subscribe") {
            streams.get(operation.deviceId)?.();
            streams.delete(operation.deviceId);
            if (streams.size >= 4) throw new Error("Device stream subscription limit");
            const release = await service.subscribe(operation.deviceId, actor, async (frame) => {
              access();
              await frames.send(frame.packet);
            });
            if (closed) release();
            else streams.set(operation.deviceId, release);
          } else if (operation.op === "unsubscribe") {
            streams.get(operation.deviceId)?.();
            streams.delete(operation.deviceId);
          }
          if (operation.op === "logs.start") {
            logs.get(operation.deviceId)?.();
            logs.delete(operation.deviceId);
            if (logs.size >= 4) throw new Error("Device log subscription limit");
            const release = await service.subscribeLogs(operation.deviceId, actor, (batch) =>
              send({ type: "devices.logs", deviceId: operation.deviceId, ...batch }),
            );
            if (closed) release();
            else logs.set(operation.deviceId, release);
          } else if (operation.op === "logs.stop") {
            logs.get(operation.deviceId)?.();
            logs.delete(operation.deviceId);
          }
          const data =
            operation.op === "screenshot" ? undefined : await service.request(operation, actor);
          access();
          if (operation.op === "screenshot") {
            // Image bytes always use the screen binary protocol; JSON is metadata only.
            const frame = await service.screenshot(operation.deviceId, actor);
            await frames.send(frame.packet);
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
