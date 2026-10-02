import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { DeviceId } from "@ace/protocol";
import { keyPair } from "@ace/secure-channel";
import { startRelay, connectHostToRelay, connectClientViaRelay } from "@ace/relay";
import { attachPreviewRelay, openPreviewProxy, previewRelayChannel } from "./index.ts";
import { serve, http, echoWebsocket, websocket, echo } from "./test-support.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function fixture(port: number) {
  const relay = await startRelay();
  cleanup.push(relay.close);
  const token = "b".repeat(64);
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    async onClientChannel(channel) {
      const hello = await channel.receive();
      // The daemon adapter supplies persistent-device authentication in production.
      if (hello.type !== "hello" || hello.token !== token) throw new Error("Not paired");
      channel.authorize();
      const endpoint = attachPreviewRelay({
        channel: previewRelayChannel(channel),
        allowPort: async (p) => p === port,
      });
      cleanup.push(endpoint.close);
      await channel.send({ type: "pong" });
    },
  });
  cleanup.push(() => host.close());
  const client = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  cleanup.push(() => client.close());
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token,
  });
  expect(await client.receive()).toEqual({ type: "pong" });
  const proxy = await openPreviewProxy({ channel: previewRelayChannel(client), port });
  cleanup.push(proxy.close);
  return { proxy, client };
}

test("real encrypted relay carries concurrent preview HTTP and websocket traffic after authenticated hello", async () => {
  const upstream = await serve((req, res) => {
    res.setHeader("set-cookie", "app=remote; Domain=localhost; Path=/");
    res.end(`${req.headers.host}|${req.headers.origin}`);
  });
  cleanup.push(upstream.close);
  const wss = echoWebsocket(upstream.server);
  cleanup.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
  const { proxy } = await fixture(upstream.port);
  const responses = await Promise.all(
    Array.from({ length: 16 }, () => http(proxy.url, { origin: proxy.url })),
  );
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(response.body).toBe(`localhost:${upstream.port}|${upstream.url}`);
    expect(response.headers["set-cookie"]).toEqual(["app=remote; Path=/"]);
  }
  const ws = await websocket(proxy.url, "");
  const closed = once(ws, "close");
  cleanup.push(async () => {
    ws.close();
    await closed;
  });
  expect(await echo(ws, "encrypted HMR")).toBe("encrypted HMR");
});

test("invalid preview bytes over the encrypted relay close both the channel and loopback listener", async () => {
  const upstream = await serve((_req, res) => res.end("reachable"));
  cleanup.push(upstream.close);
  const { client, proxy } = await fixture(upstream.port);
  expect((await http(proxy.url)).body).toBe("reachable");
  await client.sendBinary(new Uint8Array([255]));
  await client.closed;
  await proxy.close();
  await expect(http(proxy.url)).rejects.toThrow();
});
