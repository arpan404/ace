import { randomBytes } from "node:crypto";
import { DeviceId } from "@ace/protocol";
import { BULK, INTERACTIVE, keyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "../index.ts";
import type { HostChannel } from "../index.ts";
import { deferred } from "./peer.ts";
import { slowLink, type LinkShape } from "./slow-link.ts";

export interface HeadOfLine {
  /** From the approval's send to its arrival. */
  approvalMs: number;
  /** From the snapshot's send to its arrival. */
  snapshotMs: number;
  /** Whether the approval arrived before the snapshot. */
  overtook: boolean;
  /** Whether both arrived exactly as sent. */
  intact: boolean;
}

/**
 * A daemon sends a bulk message (a snapshot, `snapshotBytes` of JSON that won't deflate) to a
 * phone behind `link`, then `afterMs` later an approval-sized message: how long the approval
 * waits. `lanes` is whether both ends announced lanes; flow control is on either way.
 */
export async function measureHeadOfLine(options: {
  link: LinkShape;
  lanes: boolean;
  snapshotBytes: number;
  afterMs: number;
}): Promise<HeadOfLine> {
  const cleanup: (() => unknown)[] = [];
  try {
    const relay = await startRelay();
    cleanup.push(() => relay.close());
    const proxy = await slowLink(relay.url, options.link);
    cleanup.push(() => proxy.close());
    const arrived = deferred<HostChannel>();
    const host = await connectHostToRelay({
      relayUrl: relay.url,
      hostKeys: keyPair(),
      onClientChannel: arrived.resolve,
    });
    cleanup.push(() => host.close());
    const client = await connectClientViaRelay({
      relayUrl: proxy.url,
      hostId: host.hostId,
      pinnedFingerprint: host.hostId,
    });
    cleanup.push(() => client.close());
    const server = await arrived.promise;
    // What a client that announces lanes does before its hello, and the daemon after it.
    if (options.lanes) client.lanes?.();
    await client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("phone"),
      token: "t",
      flowControl: options.lanes ? ["credit", "lanes"] : ["credit"],
    });
    await server.receive();
    server.authorize();
    server.flowControl?.();
    if (options.lanes) server.lanes?.();
    await server.send({ type: "pong" });
    await client.receive();

    const snapshot = JSON.stringify({
      type: "snapshot",
      data: randomBytes(Math.ceil((options.snapshotBytes * 3) / 4)).toString("base64"),
    });
    const approval = JSON.stringify({ type: "approval", text: "x".repeat(600) });
    const times: Record<string, number> = {};
    let intact = true;
    const order: string[] = [];
    const reading = (async () => {
      for (let index = 0; index < 2; index++) {
        const text = await client.receiveRaw();
        if (typeof text !== "string") throw new Error("Expected text");
        const name = text === snapshot ? "snapshot" : text === approval ? "approval" : "other";
        if (name === "other") intact = false;
        times[name] = performance.now();
        order.push(name);
      }
    })();
    const snapshotAt = performance.now();
    const snapshotSent = server.sendText(snapshot, false, BULK);
    await new Promise((resolve) => setTimeout(resolve, options.afterMs));
    const approvalAt = performance.now();
    const approvalSent = server.sendText(approval, false, INTERACTIVE);
    await Promise.all([reading, snapshotSent, approvalSent]);
    return {
      approvalMs: Math.round((times.approval ?? Infinity) - approvalAt),
      snapshotMs: Math.round((times.snapshot ?? Infinity) - snapshotAt),
      overtook: order[0] === "approval",
      intact,
    };
  } finally {
    for (const close of cleanup.splice(0).toReversed()) await close();
  }
}
