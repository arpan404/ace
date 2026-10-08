import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AgentCatalog, AgentRegistry, fileCache, fileInventoryStorage } from "@ace/agent-registry";
import { AccountService, openRegistry, ProviderLoginSessions } from "@ace/accounts";
import { ModelCatalog, openModelStorage, type InstanceInput } from "@ace/models";
import { createLogger } from "@ace/diagnostics";
import { prepareAgentLogin } from "./services/provider-login-agent.ts";
import { acpModelInstanceId } from "./acp-model-instance.ts";
import { readConfig } from "./config.ts";
import { Resources } from "./services/resources.ts";
import type { ServiceContext } from "./services/types.ts";
import { fixture } from "./socket-test-support.ts";

test("an installed ACP binding enrolls and signs in before any thread exists, then invalidates existing model metadata on re-login", async () => {
  const f = await fixture();
  const resources = new Resources();
  const bin = join(f.home, "fixture-agent");
  await writeFile(
    bin,
    `#!${process.execPath}\nrequire('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const request=JSON.parse(line);console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:request.method==='initialize'?{protocolVersion:1,authMethods:[{id:'browser',name:'Sign in'}]}:{}}));
  });\n`,
    { mode: 0o700 },
  );
  const env = { HOME: f.home, PATH: "" };
  let id = 0;
  const agents = await AgentRegistry.open({
    catalog: await AgentCatalog.open({
      target: "darwin-aarch64",
      now: () => 1000,
      cache: fileCache(join(f.home, "catalog.json"), () => String(++id)),
    }),
    root: join(f.home, "installs"),
    target: "darwin-aarch64",
    env,
    storage: fileInventoryStorage(join(f.home, "inventory.json"), () => String(++id)),
  });
  resources.own(() => agents.close());
  const identity = {
    acpAgentId: "local:fixture",
    installationId: "fixture-install",
    instanceId: "fixture:default",
  };
  await agents.bind({ ...identity, version: "1.0.0", command: bin, args: [] });
  const registry = await openRegistry(join(f.home, "accounts.sqlite"), f.home);
  resources.own(() => registry.close());
  const models = new ModelCatalog({
    storage: openModelStorage(join(f.home, "models.sqlite")),
    now: () => 1000,
    deadline: () => () => {},
    discover: async () => {
      throw new Error("Generic ACP metadata must come from its session");
    },
  });
  resources.own(() => models.close());
  const log = createLogger({
    now: () => 1000,
    redact: (value) => value,
    sink: { write: async () => {}, close: async () => {} },
  });
  const context: ServiceContext = {
    config: readConfig({ ACE_HOME: f.home, ACE_PORT: "0" }, f.home),
    options: { accounts: { env }, providerStatus: { env } },
    services: {
      agentRegistry: agents,
      accountRegistry: registry,
      accounts: new AccountService({ registry, env, now: () => 1000, timeZone: "UTC" }),
      models,
    },
    resources,
    store: f.store,
    now: () => 1000,
    id: () => String(++id),
    log,
    signal: new AbortController().signal,
    onListen: [],
  };
  const sessions = new ProviderLoginSessions({
    now: () => 1000,
    id: () => `login-${++id}`,
    schedule: () => () => {},
    prepare: (target, action, signal, owner) =>
      prepareAgentLogin(
        context,
        { provider: "acp", ...(target.instance ? { instance: target.instance } : {}) },
        action,
        signal,
        owner,
      ),
  });
  try {
    const login = async () => {
      const result = await sessions.handle("device", {
        type: "provider.login.start",
        requestId: `request-${++id}`,
        provider: "acp",
        instance: identity.instanceId,
      });
      if (!result.result.ok || !("progress" in result.result)) throw new Error("Login rejected");
      expect(await sessions.completed("device", result.result.progress.session)).toMatchObject({
        state: "succeeded",
      });
    };
    await login();
    expect(registry.summary(identity.instanceId, 1000)).toMatchObject({
      availability: "available",
      quota: { auth: "logged_in" },
    });
    expect(context.services.accounts?.isChangingAccount(identity.instanceId)).toBe(false);
    const modelId = acpModelInstanceId(identity);
    await mkdir(join(f.home, "workspace"));
    const instance: InstanceInput = {
      id: modelId,
      provider: "acp",
      ...identity,
      executable: bin,
      cwd: join(f.home, "workspace"),
      loginRevision: "before-login",
    };
    models.registerInstance(instance);
    await models.updateFromSession(instance, {
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "before-login",
          options: [{ value: "before-login", name: "Before login" }],
        },
      ],
    });
    expect(models.list().models.map((model) => model.id)).toContain("before-login");
    await login();
    expect(models.list().models.map((model) => model.id)).not.toContain("before-login");
  } finally {
    await sessions.close();
    await resources.close();
    await log.close();
    await f.close();
  }
});
