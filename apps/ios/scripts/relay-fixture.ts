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
 * offered `deflate-raw`, then `pong` for every later message.
 */
const out = process.argv[2] ?? "/tmp/ace-relay-fixture.json";
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
    await channel.send({ type: "pong" });
    if (first.compression?.includes("deflate-raw")) {
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
