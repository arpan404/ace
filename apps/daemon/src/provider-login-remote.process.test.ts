import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectClientViaRelay, startRelay, type ClientChannel } from "@ace/relay";
import { ProviderLoginSessions } from "@ace/accounts";
import { nodeBinary } from "@ace/provider-kit/testing";
import { ProviderLoginResult, type ServerMessage } from "@ace/protocol";
import { startDaemon } from "./index.ts";
import { createDaemonLogger } from "./diagnostic-log.ts";
import { fixture, type Client } from "./socket-test-support.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** A Codex CLI at the process boundary: device auth prints its page and code, then waits. */
const codex = `
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('codex-cli 0.159.1');
else if (args.includes('--help')) console.log('Usage: codex login logout --with-api-key --device-auth');
else if (args.includes('status')) console.log('Not logged in');
else if (args[0] === 'app-server') require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  console.log(JSON.stringify({ id: request.id, result: request.method === 'model/list' ? { data: [], nextCursor: null } : {} }));
});
else { console.log('Open https://auth.openai.com/codex/device\\nEnter code: ABCD-12345'); process.stdin.resume(); }
`;

async function until(channel: ClientChannel, predicate: (message: ServerMessage) => boolean) {
  for (;;) {
    const message = await channel.receive();
    if (message instanceof Uint8Array) throw new Error("Unexpected binary frame");
    if (predicate(message)) return message;
  }
}

test("a phone paired with the default scopes signs in to Codex through the relay the daemon started with, seeing the device code", async () => {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const home = await mkdtemp(join(tmpdir(), "ace-remote-login-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  const user = join(home, "user");
  await Promise.all([mkdir(bin), mkdir(user)]);
  await nodeBinary(bin, "codex", codex);
  const env = { ...process.env, HOME: user, PATH: bin, CODEX_HOME: undefined };
  const daemon = await startDaemon({
    config: {
      dataDir: join(home, "data"),
      host: "127.0.0.1",
      port: 0,
      remotePort: 0,
      listen: "local",
      logLevel: "silent",
      // The relay connects while the daemon starts, before its sign-in service exists.
      relayUrl: relay.url,
    },
    accounts: { env, discovery: { env } },
    providerStatus: { env },
  });
  cleanup.push(() => daemon.close());
  // What `ace pair` grants a phone by default.
  const phone = daemon.store.devices.create("Phone", ["read", "operate"], 1);
  const hostId = daemon.relayHostId;
  const pinnedFingerprint = daemon.relayFingerprint;
  if (!hostId || !pinnedFingerprint) throw new Error("The daemon did not start its relay");
  const channel = await connectClientViaRelay({ relayUrl: relay.url, hostId, pinnedFingerprint });
  cleanup.push(async () => {
    channel.close();
    await channel.closed;
  });
  await channel.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: phone.device.id,
    token: phone.token,
    channel: "provider_auth",
  });
  expect(await channel.receive()).toMatchObject({ type: "welcome" });

  await channel.send({ type: "provider.login.start", requestId: "phone-start", provider: "codex" });
  const started = ProviderLoginResult.parse(
    await until(channel, (message) => message.type === "provider.login.result"),
  );
  if (!started.result.ok) throw new Error(`Sign-in refused: ${JSON.stringify(started.result)}`);
  const code = await until(
    channel,
    (message) => message.type === "provider.login.progress" && !!message.progress.userCode,
  );
  expect(code).toMatchObject({
    progress: {
      session: started.result.progress.session,
      state: "awaiting_code_entry",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-12345",
    },
  });

  await channel.send({
    type: "provider.login.cancel",
    requestId: "phone-cancel",
    session: started.result.progress.session,
  });
  expect(
    await until(
      channel,
      (message) => message.type === "provider.login.result" && message.requestId === "phone-cancel",
    ),
  ).toMatchObject({ result: { ok: true, progress: { state: "cancelled" } } });
}, 60_000);

async function reply(client: Client, requestId: string) {
  for (;;) {
    const message = await client.next();
    if ("requestId" in message && message.requestId === requestId) return message;
  }
}

test("sign-in that fails inside the daemon logs the cause at warn, redacted, and tells the client it was an error", async () => {
  const secret = "sk-proj-OPAQUEREMOTELOGINSECRET0123456789";
  const log = createDaemonLogger(
    { sink: { async write() {}, async close() {} }, now: () => 1 },
    { env: {} },
  );
  cleanup.push(() => log.close());
  const login = new ProviderLoginSessions({
    now: () => 1,
    id: () => "session",
    schedule: () => () => {},
    prepare: async () => {
      throw new Error("unused");
    },
    instanceKey: () => {
      throw new Error(`account registry is locked (${secret})`);
    },
  });
  cleanup.push(() => login.close());
  const f = await fixture({
    providerLogin: login,
    warn: (message, fields) => log.log("warn", message, fields),
  });
  cleanup.push(() => f.close());
  const owner = await f.connect();
  owner.send({ type: "provider.login.start", requestId: "start", provider: "codex" });
  expect(await reply(owner, "start")).toMatchObject({
    type: "provider.login.result",
    result: { ok: false, error: "unavailable", reason: "error" },
  });
  const lines = log.recent().filter((line) => line.includes("Provider sign-in unavailable"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('"level":"warn"');
  expect(lines[0]).toContain("account registry is locked");
  expect(lines[0]).toContain("codex");
  expect(lines[0]).not.toContain(secret);
});

test("a daemon whose sign-in service isn't running says so and logs it, instead of a bare refusal", async () => {
  const log = createDaemonLogger(
    { sink: { async write() {}, async close() {} }, now: () => 1 },
    { env: {} },
  );
  cleanup.push(() => log.close());
  const f = await fixture({ warn: (message, fields) => log.log("warn", message, fields) });
  cleanup.push(() => f.close());
  const owner = await f.connect();
  owner.send({ type: "provider.login.start", requestId: "start", provider: "codex" });
  expect(await reply(owner, "start")).toMatchObject({
    result: { ok: false, error: "unavailable", reason: "not_running" },
  });
  expect(log.recent().filter((line) => line.includes("Provider sign-in unavailable"))).toHaveLength(
    1,
  );
});
