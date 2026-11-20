import { writeFileSync } from "node:fs";
import { startRelay, connectHostToRelay } from "@ace/relay";
import { fingerprint, keyPair } from "@ace/secure-channel";
import type { ClientMessage } from "@ace/protocol";
import { olderRelay, startProxy, stepOneOnly, RELAY_SHORTCUTS } from "./relay-proxy.ts";

/**
 * The real Node relay with a stand-in daemon behind it, for the iOS relay socket's live test
 * (`RelayLiveTests`). Loopback only; no provider, account backend or quota is involved.
 *
 *   node scripts/relay-fixture.ts /tmp/ace-relay-fixture.json
 *
 * Writes `{ "url", "hostId" }` to the path, then serves until killed. The stand-in answers like a
 * daemon whose machine code is 2468: a hello without it gets `machine_code_required`, a wrong one
 * `machine_code_wrong`; the right one gets `pong`, then a large deflated message when the hello
 * offered `deflate-raw`, then `pong` for every later message. A hello that asks for credit gets
 * flow control, as from the daemon; device `ios-stream` gets 8 MB of text instead of the deflated
 * message, which arrives whole only if the phone returns credit. A hello presenting the grant
 * `fixture-refused` is refused as the daemon refuses a grant it won't take: `unauthorized`.
 * Device `ios-tunnel` is a tunnel connection (ADR 0194): every binary message it sends comes back
 * as the same bytes, so a round trip many flow windows long arrives only if credit flows both ways.
 *
 * `relays` are proxies in front of the same relay standing in for other relays (ADR 0155): `full`
 * passes everything, `stepOne` knows early frames but not the message in the upgrade, `older`
 * knows neither, `refusing` turns away an upgrade carrying the message, `losing` closes an early
 * connection with 4020 and `alwaysLosing` every connection, and `slowFull` and `slowOlder` add 200 ms each way. Each one's `log`
 * answers what its connections offered (entries cut to their prefix), echoed and sent.
 */
const out = process.argv[2] ?? "/tmp/ace-relay-fixture.json";
/** Text deflate can't shrink, so a stream really fills the flow window. */
function noise(length: number): string {
  let text = "";
  let state = 1;
  while (text.length < length) {
    state = (state * 48271) % 2147483647;
    text += state.toString(36);
  }
  return text.slice(0, length);
}
const relay = await startRelay({ bind: "127.0.0.1" });
const hostKeys = keyPair();
const host = await connectHostToRelay({
  relayUrl: relay.url,
  hostKeys,
  onClientChannel: async (channel) => {
    const first = await channel.receive();
    if (first.type === "hello" && first.grant === "fixture-refused") {
      channel.authorize();
      await channel.send({ type: "error", code: "unauthorized", message: "Valid hello required" });
      channel.close();
      return;
    }
    if (first.type !== "hello" || first.grant !== "fixture-grant") return channel.close();
    if (first.machineCode !== "2468") {
      const code = first.machineCode === undefined ? "machine_code_required" : "machine_code_wrong";
      // Authorized only so the refusal can be sent; the channel closes right after.
      channel.authorize();
      await channel.send({ type: "error", code, message: "This machine needs its machine code." });
      channel.close();
      return;
    }
    channel.authorize();
    // As the daemon does: credit goes only to a hello that asked, its first before any reply.
    if (first.flowControl?.includes("credit")) channel.flowControl?.();
    await channel.send({ type: "pong" });
    if (first.deviceId === "ios-stream") {
      // Eight flow windows of text that won't deflate: it all arrives only if credit comes back.
      for (let index = 0; index < 40; index++)
        await channel.sendText(
          JSON.stringify({
            type: "error",
            code: `fixture_stream_${index}`,
            message: noise(200_000),
          }),
        );
    } else if (first.compression?.includes("deflate-raw")) {
      channel.compress?.(() => true);
      await channel.send({
        type: "error",
        code: "fixture_bulk",
        message: "the same words again ".repeat(20_000),
      });
    }
    if (first.deviceId === "ios-tunnel") {
      for await (const frame of channel.frames())
        if (frame instanceof Uint8Array) await channel.sendBinary(frame.slice());
      return;
    }
    for await (const message of channel as AsyncIterable<ClientMessage>) {
      if (message.type === "ping") await channel.send({ type: "pong" });
    }
  },
});
const slow = 200;
const proxies = {
  full: await startProxy(relay.url),
  stepOne: await startProxy(relay.url, { filter: stepOneOnly }),
  older: await startProxy(relay.url, { filter: olderRelay }),
  refusing: await startProxy(relay.url, {
    refuse: (header) => header.includes(RELAY_SHORTCUTS.messagePrefix),
  }),
  losing: await startProxy(relay.url, { lose: "early" }),
  alwaysLosing: await startProxy(relay.url, { lose: "every" }),
  slowFull: await startProxy(relay.url, { delay: slow }),
  slowOlder: await startProxy(relay.url, { filter: olderRelay, delay: slow }),
};
const relays = Object.fromEntries(
  Object.entries(proxies).map(([name, proxy]) => [name, { url: proxy.url, log: proxy.log }]),
);
writeFileSync(out, JSON.stringify({ url: relay.url, hostId: host.hostId, relays }));
process.stdout.write(`relay ${relay.url} host ${fingerprint(hostKeys.publicKey)}\n`);
const stop = async () => {
  for (const proxy of Object.values(proxies)) await proxy.close();
  await host.close();
  await relay.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
