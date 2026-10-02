import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { DeviceId } from "@ace/protocol";
import { keyPair } from "@ace/secure-channel";
import { connectHostToRelay, connectClientViaRelay } from "../src/index.ts";
import type { HostChannel } from "../src/index.ts";
const name = `ace-relay-smoke-${randomUUID()}`;
const container = spawn(
  "docker",
  ["run", "--rm", "--name", name, "-p", "127.0.0.1:8787:8787", "ace-relay:test"],
  { stdio: ["ignore", "pipe", "inherit"] },
);
const exited = new Promise<number | null>((resolve, reject) => {
  container.once("error", reject);
  container.once("exit", resolve);
});
const ready = new Promise<void>((resolve, reject) => {
  let output = "";
  container.stdout.on("data", (data: Buffer) => {
    output += data.toString("utf8");
    if (output.includes("ace relay listening on port 8787")) resolve();
  });
  void exited.then(
    (code) => reject(new Error(`Container exited before listening (${code})`)),
    reject,
  );
});
let host: Awaited<ReturnType<typeof connectHostToRelay>> | undefined;
let client: Awaited<ReturnType<typeof connectClientViaRelay>> | undefined;
try {
  await ready;
  const accepted = Promise.withResolvers<HostChannel>();
  const relayUrl = "ws://127.0.0.1:8787";
  host = await connectHostToRelay({
    relayUrl,
    hostKeys: keyPair(),
    onClientChannel: accepted.resolve,
  });
  client = await connectClientViaRelay({
    relayUrl,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  const server = await accepted.promise;
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("docker-smoke"),
    token: "smoke",
  });
  assert.equal((await server.receive()).type, "hello");
  server.authorize();
  await client.send({ type: "ping" });
  assert.deepEqual(await server.receive(), { type: "ping" });
  await server.send({ type: "pong" });
  assert.deepEqual(await client.receive(), { type: "pong" });
  console.log("Docker Node 24 encrypted host/client round trip passed");
} finally {
  client?.close();
  await host?.close();
  if (container.exitCode === null) {
    const stop = spawn("docker", ["stop", name], { stdio: "inherit" });
    await new Promise<void>((resolve, reject) => {
      stop.once("error", reject);
      stop.once("exit", () => resolve());
    });
  }
  await exited;
}
