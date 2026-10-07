import { ModelCatalog, openModelStorage, normalizeCodex, ModelInstance } from "@ace/models";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openRegistry, AccountService } from "@ace/accounts";
import { createLogger } from "@ace/diagnostics";
import { AccountManagement } from "./account-management.ts";
import { startProviderLogin } from "./services/provider-login.ts";
import { Resources } from "./services/resources.ts";
import { readConfig } from "./config.ts";
import { fixture, type Client } from "./socket-test-support.ts";
import { accessRequest } from "./client-access.ts";
import { SocketTicket, DeviceId, type ClientMessage, type ServerMessage } from "@ace/protocol";
import type { ServiceContext } from "./services/types.ts";

const sentinel = "opaque-provider-accounts-test-key";
async function until(
  client: Client,
  seen: ServerMessage[],
  predicate: (message: ServerMessage) => boolean,
) {
  for (;;) {
    const message = await client.next();
    seen.push(message);
    if (predicate(message)) return message;
  }
}
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "ace-provider-accounts-"));
  const dataDir = join(root, "daemon"),
    normal = join(root, "normal"),
    bin = join(root, "bin");
  await Promise.all([mkdir(dataDir), mkdir(normal), mkdir(bin)]);
  await writeFile(join(normal, "untouched"), "user CLI home");
  const script = `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);const home=process.env.CODEX_HOME||path.join(process.env.HOME,'.codex');
if(args[0]==='--version')console.log('codex-cli 0.159.1');
else if(args.includes('--help'))console.log('Usage: codex login logout --with-api-key --device-auth');
else if(args.includes('status'))console.log(fs.existsSync(home+'/credential')?'Logged in using an API key - '+fs.readFileSync(home+'/credential','utf8'):'Not logged in');
else if(args[0]==='logout'){if(fs.existsSync(home+'/refuse-logout')){console.error(fs.readFileSync(home+'/credential','utf8'));process.exit(1);}fs.rmSync(home+'/credential',{force:true});fs.writeFileSync(home+'/logged-out','true');}
else if(args.includes('--with-api-key')){fs.writeFileSync(home+'/launch.json',JSON.stringify({args,env:process.env}));let value='';process.stdin.on('data',part=>value+=part);process.stdin.on('end',()=>{fs.mkdirSync(home,{recursive:true});fs.writeFileSync(home+'/credential',value.trim());console.log(value);console.error(value);});}
else {console.log('Open https://auth.openai.com/codex/device\\nEnter code: ABCD-12345');process.stdin.on('data',()=>{fs.mkdirSync(home,{recursive:true});fs.writeFileSync(home+'/credential','browser-fixture');process.exit(0);});}
`;
  await writeFile(join(bin, "codex"), script, { mode: 0o700 });
  const env = {
    ...process.env,
    HOME: normal,
    PATH: bin,
    CODEX_HOME: undefined,
    OPENAI_API_KEY: undefined,
  };
  const registry = await openRegistry(join(dataDir, "accounts.sqlite"), dataDir);
  const accounts = new AccountService({ registry, env, now: () => 1000, timeZone: "UTC" });
  let sequence = 0;
  const logs: string[] = [];
  const resources = new Resources();
  const models = new ModelCatalog({
    storage: openModelStorage(join(dataDir, "models.sqlite")),
    now: () => 1000,
    deadline: () => () => {},
    discover: async (instance) =>
      normalizeCodex(
        {
          data: [
            {
              id: "fixture",
              model: `revision-${instance.loginRevision}`,
              displayName: "Fixture model",
              isDefault: true,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: "high",
            },
          ],
          nextCursor: null,
        },
        ModelInstance.parse(instance),
      ),
  });
  resources.own(() => models.close());
  const log = createLogger({
    now: () => 1000,
    redact: (value) => value,
    sink: {
      write: async (value) => {
        logs.push(String(value));
      },
      close: async () => {},
    },
  });
  const shell = await fixture();
  const context: ServiceContext = {
    config: readConfig({ ACE_HOME: dataDir, ACE_PORT: "0" }, dataDir),
    options: { accounts: { env, discovery: { env } }, providerStatus: { env } },
    services: { accountRegistry: registry, accounts, models },
    store: shell.store,
    now: () => 1000,
    id: () => `id-${++sequence}`,
    signal: new AbortController().signal,
    resources,
    log,
    onListen: [],
  };
  await startProviderLogin(context);
  const login = context.services.providerLogin;
  if (!login) throw new Error("Login unavailable");
  const management = new AccountManagement({
    registry,
    accounts,
    env,
    dataDir,
    now: () => 1000,
    id: () => `account-${++sequence}`,
    models: () => models,
    discovery: { env },
  });
  await management.initialize();
  const socket = await fixture({
    accountManagement: management,
    accounts,
    models,
    providerLogin: login,
  });
  const owner = await socket.connect();
  await owner.next();
  const seen: ServerMessage[] = [];
  async function request(message: ClientMessage, client = owner) {
    client.send(message);
    return until(
      client,
      seen,
      (reply) =>
        "requestId" in reply && "requestId" in message && reply.requestId === message.requestId,
    );
  }
  return {
    ...socket,
    owner,
    seen,
    request,
    registry,
    models,
    login,
    dataDir,
    normal,
    logs,
    log,
    async close() {
      await socket.close();
      await management.close();
      await resources.close();
      await shell.close();
      registry.close();
      await log.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("provider account actions add and start isolated sign-in, label, select, reauthenticate and logout before removing", async () => {
  const f = await harness();
  try {
    expect(
      await f.request({
        type: "provider.accounts.list",
        requestId: "cursor-default",
        provider: "cursor",
      }),
    ).toMatchObject({
      result: {
        accounts: [
          expect.objectContaining({
            id: "cursor-sdk-default",
            isDefault: true,
            authMethod: "unknown",
          }),
        ],
      },
    });
    const added = await f.request({
      type: "provider.accounts.add",
      requestId: "add",
      provider: "codex",
      label: "Work",
      method: "api_key",
    });
    if (added.type !== "provider.accounts.result" || !added.result.ok || !added.result.progress)
      throw new Error("Missing account login");
    const { session, instance: instanceId } = added.result.progress;
    if (!instanceId) throw new Error("Missing instance");
    await until(
      f.owner,
      f.seen,
      (message) =>
        message.type === "provider.login.progress" && message.progress.state === "awaiting_api_key",
    );
    await f.request({
      type: "provider.login.apiKey",
      requestId: "submit",
      session,
      apiKey: sentinel,
    });
    expect(await f.login.completed("device", session)).toMatchObject({ state: "succeeded" });
    const listed = await f.request({
      type: "provider.accounts.list",
      requestId: "list",
      provider: "codex",
    });
    expect(listed).toMatchObject({
      result: {
        ok: true,
        apiKey: { supported: true },
        accounts: expect.arrayContaining([
          expect.objectContaining({
            id: instanceId,
            authMethod: "api_key",
            status: "available",
            label: "Work",
          }),
        ]),
      },
    });
    expect(Number(f.registry.get(instanceId)?.instance.loginRevision)).toBeGreaterThan(0);
    expect(f.models.list().models.map((model) => model.nativeModelId)).toContain(
      `revision-${f.registry.get(instanceId)?.instance.loginRevision}`,
    );

    expect(
      await f.request({
        type: "provider.accounts.rename",
        requestId: "rename",
        provider: "codex",
        instanceId,
        label: "Team",
      }),
    ).toMatchObject({
      result: {
        accounts: expect.arrayContaining([
          expect.objectContaining({ id: instanceId, label: "Team" }),
        ]),
      },
    });
    expect(
      await f.request({
        type: "provider.accounts.setDefault",
        requestId: "default",
        provider: "codex",
        instanceId,
      }),
    ).toMatchObject({
      result: {
        accounts: expect.arrayContaining([
          expect.objectContaining({ id: instanceId, isDefault: true }),
        ]),
      },
    });
    const again = await f.request({
      type: "provider.accounts.reauth",
      requestId: "again",
      provider: "codex",
      instanceId,
      method: "api_key",
    });
    if (again.type !== "provider.accounts.result" || !again.result.ok || !again.result.progress)
      throw new Error("Missing reauth");
    const reauthSession = again.result.progress.session;
    await until(
      f.owner,
      f.seen,
      (message) =>
        message.type === "provider.login.progress" &&
        message.progress.session === reauthSession &&
        message.progress.state === "awaiting_api_key",
    );
    await f.request({
      type: "provider.login.cancel",
      requestId: "cancel",
      session: again.result.progress.session,
    });
    const home = join(f.dataDir, "account-homes", instanceId);
    expect(await readFile(join(home, "launch.json"), "utf8")).not.toContain(sentinel);
    expect(JSON.stringify(f.seen)).not.toContain(sentinel);
    await f.log.flush();
    expect(f.logs.join("\n")).not.toContain(sentinel);
    expect(JSON.stringify(f.registry.list())).not.toContain(sentinel);
    expect(JSON.stringify(f.models.list())).not.toContain(sentinel);
    for (const file of await readdir(f.dataDir))
      if (/\.sqlite(?:-wal|-shm)?$/.test(file))
        expect((await readFile(join(f.dataDir, file))).includes(Buffer.from(sentinel))).toBe(false);
    expect(
      (await readFile(join(f.dataDir, "accounts.sqlite"))).includes(Buffer.from(sentinel)),
    ).toBe(false);
    expect(JSON.stringify(f.store.readEvents({ afterSeq: 0, limit: 1000 }))).not.toContain(
      sentinel,
    );
    expect(
      await f.request({
        type: "provider.accounts.remove",
        requestId: "remove",
        deleteHome: false,
        provider: "codex",
        instanceId,
        confirm: true,
      }),
    ).toMatchObject({ result: { ok: true } });
    expect(await readFile(join(home, "logged-out"), "utf8")).toBe("true");
    expect(f.registry.get(instanceId)).toBeUndefined();
    expect(await readdir(f.normal)).toEqual(["untouched"]);
    expect(
      await f.request({
        type: "provider.accounts.remove",
        requestId: "implicit",
        provider: "codex",
        instanceId: "codex-cli-default",
        confirm: true,
        deleteHome: true,
      }),
    ).toMatchObject({ result: { ok: false, error: "failed" } });
    expect(await readdir(f.normal)).toEqual(["untouched"]);
  } finally {
    await f.close();
  }
});

test("paired sockets cannot submit keys even with operate scope, and read-only clients cannot manage accounts", async () => {
  const f = await harness();
  try {
    for (const scopes of [["read"], ["read", "operate"]] as const) {
      const device = f.store.devices.create("Phone", [...scopes], 1000);
      const ticket = SocketTicket.parse(
        await accessRequest(f.server.httpUrl, "/v1/tickets", {
          method: "POST",
          token: device.token,
        }),
      );
      const client = await f.open();
      client.send({
        type: "hello",
        deviceId: DeviceId.parse(device.device.id),
        protocolVersion: 1,
        ticket: ticket.ticket,
      });
      await client.next();
      expect(
        await f.request(
          { type: "provider.login.apiKey", requestId: "key", session: "absent", apiKey: sentinel },
          client,
        ),
      ).toMatchObject({ result: { ok: false, error: "forbidden" } });
      if (scopes.length === 1)
        expect(
          await f.request(
            {
              type: "provider.accounts.add",
              requestId: "add-forbidden",
              provider: "codex",
              method: "login",
            },
            client,
          ),
        ).toMatchObject({ result: { error: "forbidden" } });
    }
    expect(JSON.stringify(f.seen)).not.toContain(sentinel);
  } finally {
    await f.close();
  }
});

test("a failed native logout retains the account, and confirmed deletion removes only its managed home after retry", async () => {
  const f = await harness();
  try {
    const added = await f.request({
      type: "provider.accounts.add",
      requestId: "add-delete",
      provider: "codex",
      method: "api_key",
    });
    if (
      added.type !== "provider.accounts.result" ||
      !added.result.ok ||
      !added.result.progress?.instance
    )
      throw new Error("Missing account");
    const { session, instance: instanceId } = added.result.progress;
    await until(
      f.owner,
      f.seen,
      (message) =>
        message.type === "provider.login.progress" &&
        message.progress.session === session &&
        message.progress.state === "awaiting_api_key",
    );
    await f.request({
      type: "provider.login.apiKey",
      requestId: "submit-delete",
      session,
      apiKey: sentinel,
    });
    await f.login.completed("device", session);
    const home = join(f.dataDir, "account-homes", instanceId);
    await writeFile(join(home, "refuse-logout"), "fake CLI rejection");
    expect(
      await f.request({
        type: "provider.accounts.remove",
        requestId: "refuse-delete",
        provider: "codex",
        instanceId,
        confirm: true,
        deleteHome: true,
      }),
    ).toMatchObject({ result: { ok: false, error: "failed" } });
    expect(f.registry.get(instanceId)?.quota.auth).toBe("logged_in");
    expect(await readFile(join(home, "credential"), "utf8")).toBe(sentinel);
    await rm(join(home, "refuse-logout"));
    expect(
      await f.request({
        type: "provider.accounts.remove",
        requestId: "retry-delete",
        provider: "codex",
        instanceId,
        confirm: true,
        deleteHome: true,
      }),
    ).toMatchObject({ result: { ok: true } });
    expect(await readdir(join(f.dataDir, "account-homes"))).not.toContain(instanceId);
    expect(await readdir(f.normal)).toEqual(["untouched"]);
    expect(JSON.stringify(f.seen)).not.toContain(sentinel);
  } finally {
    await f.close();
  }
});

test("legacy removal keeps its reply contract and logs out the managed CLI before unregistering", async () => {
  const f = await harness();
  try {
    const added = await f.request({
      type: "provider.accounts.add",
      requestId: "add-legacy",
      provider: "codex",
      method: "api_key",
    });
    if (added.type !== "provider.accounts.result" || !added.result.ok || !added.result.progress)
      throw new Error("Missing account login");
    const session = added.result.progress.session;
    const instanceId = added.result.progress.instance;
    if (!instanceId) throw new Error("Missing account");
    await until(
      f.owner,
      f.seen,
      (message) =>
        message.type === "provider.login.progress" &&
        message.progress.session === session &&
        message.progress.state === "awaiting_api_key",
    );
    await f.request({ type: "provider.login.cancel", requestId: "cancel-legacy", session });
    expect(
      await f.request({
        type: "accounts.remove",
        requestId: "remove-legacy",
        instanceId,
        deleteHome: false,
      }),
    ).toMatchObject({ type: "accounts.changed", account: null });
    expect(await readFile(join(f.dataDir, "account-homes", instanceId, "logged-out"), "utf8")).toBe(
      "true",
    );
    expect(f.registry.get(instanceId)).toBeUndefined();
    expect(await readdir(f.normal)).toEqual(["untouched"]);
  } finally {
    await f.close();
  }
});
