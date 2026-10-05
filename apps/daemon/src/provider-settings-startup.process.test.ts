import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { expect, test, vi } from "vitest";
import { ProviderKind, DeviceId } from "@ace/protocol";
import { startDaemon, readConfig } from "@ace/daemon";
import { Client } from "./socket-test-support.ts";
import { until } from "./engine/test-support.ts";

test("daemon startup honours disabled providers, syncs settings to two sockets and refreshes an enabled custom binary", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-provider-settings-"));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const clients: Client[] = [];
  vi.stubEnv("PATH", home);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  onTestFinished(async () => {
    for (const client of clients) await client.close();
    await daemon?.close();
    await rm(home, { recursive: true, force: true });
  });
  const executable = join(home, "my-codex");
  const marker = join(home, "invoked");
  await writeFile(
    executable,
    `#!${process.execPath}
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(${JSON.stringify(marker)}, 'invoked');
const args=process.argv.slice(2).join(' ');
if(args==='--version') console.log('codex-cli 0.159.1');
else if(args==='login status') console.log('Logged in using ChatGPT');
else if(args.startsWith('app-server')) createInterface({input:process.stdin}).on('line', line=>{
  const r=JSON.parse(line); if(r.method==='initialized') return;
  if(!['initialize','model/list'].includes(r.method)) process.exit(8);
  const result=r.method==='initialize'?{}:{data:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',isDefault:true,supportedReasoningEfforts:[],defaultReasoningEffort:'high'}],nextCursor:null};
  console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
});
else process.exit(9);
`,
    { mode: 0o700 },
  );
  // Both PATH discovery and an explicit override would run a real fixture if suppression broke.
  await writeFile(join(home, "codex"), await readFile(executable, "utf8"), { mode: 0o700 });
  const disabled = ProviderKind.options.map((provider) => ({ provider, enabled: false }));
  const startupDisabled = disabled.map((row) =>
    row.provider === "codex" ? { ...row, binaryPath: executable } : row,
  );
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ version: 2, settings: { "providers.configuration": startupDisabled } }),
  );
  daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    toolkits: [],
    engine: {
      cursor: {
        discovery: {
          resolve() {
            throw Object.assign(new Error("No SDK in fixture"), { code: "MODULE_NOT_FOUND" });
          },
        },
      },
    },
    history: { instances: [] },
  });
  await daemon.models.refresh();
  expect(daemon.models.list().instances).toMatchObject([
    { provider: "codex", enabled: false, refreshing: false },
  ]);
  expect(daemon.models.list().models).toEqual([]);
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  const token = await readFile(daemon.tokenPath, "utf8");
  for (const id of ["desktop", "phone"]) {
    const client = new Client(daemon.url);
    clients.push(client);
    await once(client.socket, "open");
    client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse(id), token });
    await until(client, (message) => message.type === "welcome");
    client.send({
      type: "settings.subscribe",
      requestId: id,
      subscriptionId: id,
      scope: {},
      keys: ["providers.configuration"],
    });
    expect(await until(client, (message) => message.type === "settings.result")).toMatchObject({
      ok: true,
    });
  }
  const desktop = clients[0];
  const phone = clients[1];
  if (!desktop || !phone) throw new Error("Missing clients");
  desktop.send({
    type: "settings.set",
    requestId: "enable",
    layer: { kind: "global" },
    key: "providers.configuration",
    // oxlint-disable-next-line oxc/no-map-spread -- Preserve the disabled baseline for other providers.
    value: disabled.map((row) =>
      row.provider === "codex"
        ? { ...row, enabled: true, binaryPath: executable, hiddenModels: ["gpt-6.1-sol"] }
        : row,
    ),
  });
  expect(await until(phone, (message) => message.type === "settings.changed")).toMatchObject({
    entries: [{ key: "providers.configuration" }],
  });
  expect(
    await until(
      desktop,
      (message) => message.type === "settings.result" && message.requestId === "enable",
    ),
  ).toMatchObject({ ok: true });
  desktop.send({ type: "models.refresh", requestId: "refresh", filter: { provider: "codex" } });
  expect(
    await until(
      desktop,
      (message) => message.type === "models.result" && message.requestId === "refresh",
    ),
  ).toMatchObject({
    result: {
      models: [{ id: "gpt-6.1-sol", hidden: true, visibilityReason: "model_hidden" }],
      instances: [{ enabled: true, refreshing: false, lastRefreshedAt: expect.any(Number) }],
    },
  });
  await writeFile(
    join(home, "codex"),
    (await readFile(executable, "utf8")).replaceAll("gpt-6.1-sol", "gpt-6.1-default"),
    { mode: 0o700 },
  );
  desktop.send({
    type: "settings.set",
    requestId: "restore-default",
    layer: { kind: "global" },
    key: "providers.configuration",
    // oxlint-disable-next-line oxc/no-map-spread -- Remove the override without enabling other providers.
    value: disabled.map((row) => (row.provider === "codex" ? { ...row, enabled: true } : row)),
  });
  expect(
    await until(
      desktop,
      (message) => message.type === "settings.result" && message.requestId === "restore-default",
    ),
  ).toMatchObject({ ok: true });
  desktop.send({
    type: "models.refresh",
    requestId: "default-models",
    filter: { provider: "codex" },
  });
  expect(
    await until(
      desktop,
      (message) => message.type === "models.result" && message.requestId === "default-models",
    ),
  ).toMatchObject({ result: { models: [{ id: "gpt-6.1-default", hidden: false }] } });
});
