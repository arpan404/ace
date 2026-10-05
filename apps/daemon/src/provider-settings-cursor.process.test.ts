import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, test, vi } from "vitest";
import { DeviceId, ProviderKind } from "@ace/protocol";
import { startDaemon, readConfig } from "@ace/daemon";
import { spawnSupervised } from "@ace/provider-kit/process";
import { Client } from "./socket-test-support.ts";
import { until } from "./engine/test-support.ts";

test("enabling Cursor after disabled startup admits its SDK account, models and auth on an existing socket", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-enable-cursor-"));
  const dataDir = join(home, "daemon");
  await mkdir(dataDir);
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", home);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let client: Client | undefined;
  onTestFinished(async () => {
    await client?.close();
    await daemon?.close();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });
  const entry = join(home, "sdk.mjs");
  await writeFile(
    entry,
    `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
const result=r.method==='status'?{status:'logged-in',source:'sdk-store'}:
r.method==='models'?[{id:'private-model',displayName:process.env.HOME}]:{disposed:true};
console.log(JSON.stringify({id:r.id,result}));});`,
  );
  const disabled = ProviderKind.options.map((provider) => ({ provider, enabled: false }));
  await writeFile(
    join(dataDir, "settings.json"),
    JSON.stringify({ version: 2, settings: { "providers.configuration": disabled } }),
  );
  daemon = await startDaemon({
    config: readConfig({ ACE_HOME: dataDir, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }, home),
    toolkits: [],
    history: { instances: [] },
    engine: {
      cursor: {
        env: {},
        entry,
        discovery: {
          platform: "linux",
          arch: "x64",
          nodeVersion: "24.0.0",
          resolve: (id) => (id === "@cursor/sdk" ? "/sdk/index.js" : "/helper/package.json"),
          read: async (path) =>
            path === "/sdk/package.json"
              ? '{"name":"@cursor/sdk","version":"1.0.35"}'
              : '{"name":"@cursor/sdk-linux-x64","version":"1.0.35"}',
          executable: async () => {},
        },
      },
    },
    modelDiscovery: {
      spawn: (options) => spawnSupervised({ ...options, command: process.execPath, args: [entry] }),
    },
  });
  client = new Client(daemon.url);
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("enable-sdk"),
    token: await readFile(daemon.tokenPath, "utf8"),
  });
  await until(client, (message) => message.type === "welcome");
  expect(daemon.models.list({ provider: "cursor" }).instances).toEqual([]);
  client.send({
    type: "settings.set",
    requestId: "enable-sdk",
    key: "providers.configuration",
    layer: { kind: "global" },
    // oxlint-disable-next-line oxc/no-map-spread -- Retain other providers' disabled settings.
    value: disabled.map((row) => (row.provider === "cursor" ? { ...row, enabled: true } : row)),
  });
  expect(
    await until(
      client,
      (message) => message.type === "settings.result" && message.requestId === "enable-sdk",
    ),
  ).toMatchObject({ ok: true });
  client.send({
    type: "cursor.auth.status",
    requestId: "status",
    instanceId: "cursor-sdk-default",
  });
  expect(
    await until(client, (message) => "requestId" in message && message.requestId === "status"),
  ).toMatchObject({
    type: "cursor.auth.changed",
    auth: { status: "logged-in", source: "sdk-store" },
  });
  client.send({ type: "models.refresh", requestId: "models", filter: { provider: "cursor" } });
  const models = await until(
    client,
    (message) => message.type === "models.result" && message.requestId === "models",
  );
  expect(models).toMatchObject({
    result: {
      models: [
        {
          id: "private-model",
          instance: "cursor-sdk-default",
          displayName: join(dataDir, "instances", "cursor-sdk-default", "user"),
        },
      ],
      instances: [{ enabled: true, refreshing: false }],
    },
  });
  client.send({ type: "accounts.list", requestId: "accounts" });
  expect(
    await until(client, (message) => "requestId" in message && message.requestId === "accounts"),
  ).toMatchObject({ accounts: [{ id: "cursor-sdk-default" }] });
  // Repeated disable/enable must retain the owner/account and cached model generation.
  await daemon.settings?.set("providers.configuration", disabled, { kind: "global" });
  await daemon.settings?.set("providers.configuration", [{ provider: "cursor", enabled: true }], {
    kind: "global",
  });
  client.send({ type: "models.refresh", requestId: "again", filter: { provider: "cursor" } });
  expect(
    await until(
      client,
      (message) => message.type === "models.result" && message.requestId === "again",
    ),
  ).toMatchObject({
    result: { models: [{ id: "private-model", instance: "cursor-sdk-default" }] },
  });
});
