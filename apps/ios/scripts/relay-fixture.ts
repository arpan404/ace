import { writeFileSync } from "node:fs";
import { startRelay, connectHostToRelay } from "@ace/relay";
import { fingerprint, keyPair } from "@ace/secure-channel";
import type { ClientMessage } from "@ace/protocol";

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
 * message, which arrives whole only if the phone returns credit.
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
    for await (const message of channel as AsyncIterable<ClientMessage>) {
      if (message.type === "ping") await channel.send({ type: "pong" });
    }
  },
});
writeFileSync(out, JSON.stringify({ url: relay.url, hostId: host.hostId }));
process.stdout.write(`relay ${relay.url} host ${fingerprint(hostKeys.publicKey)}\n`);
const stop = async () => {
  await host.close();
  await relay.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
