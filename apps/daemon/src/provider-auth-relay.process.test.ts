import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { startRelay, connectClientViaRelay, type ClientChannel } from "@ace/relay";
import { keyPair, fingerprint } from "@ace/secure-channel";
import { ProviderLoginSessions } from "@ace/accounts";
import type { ServerMessage } from "@ace/protocol";
import { RemoteAuth } from "./remote-auth.ts";
import { Store } from "./store.ts";
import { startFilesRelay } from "./files-relay.ts";
import { apiKeyLoginDriver } from "./provider-api-key.ts";

async function receive(
  client: ClientChannel,
  seen: ServerMessage[],
  predicate: (message: ServerMessage) => boolean,
) {
  for (;;) {
    const message = await client.receive();
    if (message instanceof Uint8Array) throw new Error("Unexpected binary");
    seen.push(message);
    if (predicate(message)) return message;
  }
}

test("only the paired device with operate scope hands a key through the encrypted provider-auth relay", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-key-relay-"));
  const store = new Store(join(home, "events.sqlite"));
  const auth = new RemoteAuth(store.devices, "host-local-token", {
    now: () => 1,
    secret: randomUUID,
  });
  const operator = auth.redeem(auth.pairing(["read", "operate"]).code, "Operator");
  const reader = auth.redeem(auth.pairing(["read"]).code, "Reader");
  await writeFile(
    join(home, "cli.cjs"),
    "let value='';process.stdin.on('data',chunk=>value+=chunk);process.stdin.on('end',()=>require('node:fs').writeFileSync(process.env.HOME+'/cli-credential',value.trim()));",
  );
  let sequence = 0;
  const login = new ProviderLoginSessions({
    now: () => 1,
    id: () => `relay-session-${++sequence}`,
    schedule: () => () => {},
    prepare: async () =>
      apiKeyLoginDriver({
        command: process.execPath,
        args: [join(home, "cli.cjs")],
        env: { ...process.env, HOME: home },
        cwd: home,
      }),
  });
  const relay = await startRelay();
  const keys = keyPair();
  const host = await startFilesRelay({
    url: relay.url,
    keys,
    providerLogin: login,
    auth,
    devices: store.devices,
    hostId: "fixture",
    headSeq: () => 0,
  });
  const clients: ClientChannel[] = [];
  const seen: ServerMessage[] = [];
  async function connect(credential: typeof operator) {
    const client = await connectClientViaRelay({
      relayUrl: relay.url,
      hostId: host.hostId,
      pinnedFingerprint: fingerprint(keys.publicKey),
    });
    clients.push(client);
    await client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: credential.device.id,
      token: credential.token,
      channel: "provider_auth",
    });
    expect(await client.receive()).toMatchObject({ type: "welcome" });
    return client;
  }
  try {
    const owner = await connect(operator),
      readonly = await connect(reader);
    await readonly.send({
      type: "provider.login.start",
      requestId: "denied",
      provider: "codex",
      method: "api_key",
    });
    expect(await readonly.receive()).toMatchObject({
      type: "provider.login.result",
      result: { error: "forbidden" },
    });
    await owner.send({
      type: "provider.login.start",
      requestId: "start",
      provider: "codex",
      method: "api_key",
    });
    const waiting = await receive(
      owner,
      seen,
      (message) =>
        message.type === "provider.login.progress" && message.progress.state === "awaiting_api_key",
    );
    if (waiting.type !== "provider.login.progress") throw new Error("Missing key prompt");
    const session = waiting.progress.session;
    await readonly.send({
      type: "provider.login.apiKey",
      requestId: "wrong",
      session,
      apiKey: "opaque-relay-sentinel-key",
    });
    expect(await readonly.receive()).toMatchObject({ result: { error: "forbidden" } });
    await owner.send({
      type: "provider.login.apiKey",
      requestId: "submit",
      session,
      apiKey: "opaque-relay-sentinel-key",
    });
    expect(
      await receive(
        owner,
        seen,
        (message) =>
          message.type === "provider.login.progress" && message.progress.state === "succeeded",
      ),
    ).toMatchObject({ progress: { state: "succeeded" } });
    expect(await readFile(join(home, "cli-credential"), "utf8")).toBe("opaque-relay-sentinel-key");
    expect(JSON.stringify(seen)).not.toContain("opaque-relay-sentinel-key");
    expect(JSON.stringify(store.readEvents({ afterSeq: 0, limit: 1000 }))).not.toContain(
      "opaque-relay-sentinel-key",
    );
  } finally {
    for (const client of clients) {
      client.close();
      await client.closed;
    }
    await host.close();
    await login.close();
    await relay.close();
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
