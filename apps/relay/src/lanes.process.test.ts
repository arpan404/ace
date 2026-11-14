import { afterEach, expect, it } from "vitest";
import { DeviceId } from "@ace/protocol";
import { BULK, FLOW_WINDOW, INTERACTIVE, keyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "./index.ts";
import type { HostChannel } from "./index.ts";
import { deferred } from "./testing/peer.ts";
import { measureHeadOfLine } from "./testing/head-of-line.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** A daemon channel and a phone channel through a local relay; `lanes` for both ends or none. */
async function pair(options: { lanes: boolean; compress?: boolean }) {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const arrived = deferred<HostChannel>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel: arrived.resolve,
  });
  cleanup.push(() => host.close());
  const client = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  cleanup.push(() => client.close());
  const server = await arrived.promise;
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
  if (options.compress) server.compress?.(() => true);
  await server.send({ type: "pong" });
  await client.receive();
  return { server, client };
}

/** JSON text of `bytes` that deflates well, tagged so the reader can tell messages apart. */
const bulky = (tag: string, bytes: number) =>
  JSON.stringify({ type: "snapshot", tag, data: `${tag} `.repeat(bytes / (tag.length + 1)) });
const tagOf = (text: string | Uint8Array) =>
  typeof text === "string" ? (JSON.parse(text) as { tag: string }).tag : "binary";

it("an approval sent while a snapshot crosses a slow link arrives first, within about a second", async () => {
  // 2 Mbit/s and 200 ms round trips, so the snapshot alone takes four seconds.
  const link = { bytesPerSecond: 250_000, roundTripMs: 200 };
  const before = await measureHeadOfLine({
    link,
    lanes: false,
    snapshotBytes: 1024 * 1024,
    afterMs: 300,
  });
  const after = await measureHeadOfLine({
    link,
    lanes: true,
    snapshotBytes: 1024 * 1024,
    afterMs: 300,
  });
  expect(before.overtook).toBe(false);
  expect(before.approvalMs).toBeGreaterThan(3000);
  expect(after.overtook).toBe(true);
  expect(after.approvalMs).toBeLessThan(1500);
  expect(after.intact && before.intact).toBe(true);
}, 30_000);

it("a peer that never announced lanes reads every message in the order it was sent", async () => {
  const { server, client } = await pair({ lanes: false });
  const sends = [
    server.sendText(bulky("a", 200_000), false, BULK),
    server.sendText(bulky("b", 100), false, INTERACTIVE),
    server.sendText(bulky("c", 200_000), false, BULK),
  ];
  const tags = [];
  for (let index = 0; index < 3; index++) tags.push(tagOf(await client.receiveRaw()));
  await Promise.all(sends);
  expect(tags).toEqual(["a", "b", "c"]);
});

it("a message being deflated off the main thread keeps its place in its lane", async () => {
  const { server, client } = await pair({ lanes: true, compress: true });
  // Over 256 KiB, so its deflate is asynchronous; the small ones behind it are not.
  const sends = [
    server.sendText(bulky("big", 2 * 1024 * 1024), true, BULK),
    server.sendText(bulky("small-bulk", 2000), true, BULK),
    server.sendText(bulky("approval", 2000), true, INTERACTIVE),
  ];
  const tags = [];
  for (let index = 0; index < 3; index++) tags.push(tagOf(await client.receiveRaw()));
  await Promise.all(sends);
  expect(tags.filter((tag) => tag !== "approval")).toEqual(["big", "small-bulk"]);
  expect(tags[0]).toBe("approval");
});

it("without lanes an asynchronous deflate still holds back every later message", async () => {
  const { server, client } = await pair({ lanes: false, compress: true });
  const sends = [
    server.sendText(bulky("big", 2 * 1024 * 1024), true, BULK),
    server.sendText(bulky("small", 2000), true, INTERACTIVE),
  ];
  const tags = [];
  for (let index = 0; index < 2; index++) tags.push(tagOf(await client.receiveRaw()));
  await Promise.all(sends);
  expect(tags).toEqual(["big", "small"]);
});

it("a stalled reader still holds a lanes sender to one window, and everything arrives after", async () => {
  const { server, client } = await pair({ lanes: true });
  const MESSAGE = 60 * 1024;
  let written = 0;
  const sends = Array.from({ length: 64 }, (_, index) =>
    server
      .sendBinary(new Uint8Array(MESSAGE).fill(index % 251))
      .then(() => void (written += MESSAGE)),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(written).toBeLessThanOrEqual(FLOW_WINDOW + MESSAGE);
  expect(server.bufferedBytes).toBeGreaterThan(64 * MESSAGE - FLOW_WINDOW - 2 * MESSAGE);
  const received: number[] = [];
  for (let index = 0; index < 64; index++) received.push((await client.receiveBinary())[0] ?? -1);
  await Promise.all(sends);
  expect(received).toEqual(Array.from({ length: 64 }, (_, index) => index % 251));
  expect(server.bufferedBytes).toBe(0);
});
