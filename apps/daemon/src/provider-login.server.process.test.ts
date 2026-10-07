import { accessRequest } from "./client-access.ts";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { nodeBinary } from "@ace/provider-kit/testing";
import { openRegistry, AccountService } from "@ace/accounts";
import { ModelCatalog, normalizeCodex, ModelInstance, openModelStorage } from "@ace/models";
import { SocketTicket, DeviceId, type ServerMessage } from "@ace/protocol";
import { createLogger } from "@ace/diagnostics";
import { startProviderLogin } from "./services/provider-login.ts";
import { ProviderStatuses } from "./provider-status.ts";
import { Onboarding } from "./onboarding.ts";
import { readConfig } from "./config.ts";
import { Resources } from "./services/resources.ts";
import type { ServiceContext } from "./services/types.ts";
import { fixture, type Client } from "./socket-test-support.ts";

async function next(
  client: Client,
  predicate: (message: ServerMessage) => boolean,
  seen: ServerMessage[],
): Promise<ServerMessage> {
  for (;;) {
    const message = await client.next();
    seen.push(message);
    if (predicate(message)) return message;
  }
}

test("paired operate clients sign into the default CLI home, replace the catalog generation and receive readiness pushes", async () => {
  const root = await fixture();
  const resources = new Resources();
  let server: Awaited<ReturnType<typeof fixture>> | undefined;
  const logs: string[] = [];
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
  try {
    const bin = join(root.home, "bin");
    await mkdir(bin);
    await nodeBinary(
      bin,
      "codex",
      `
      const fs=require('node:fs'); const args=process.argv.slice(2); const home=process.env.CODEX_HOME || process.env.HOME+'/.codex';
      if(args.includes('--version'))console.log('codex-cli 0.159.1');
      else if(args.includes('--help'))console.log('Usage: codex login logout [OPTIONS]\\n--device-auth');
      else if(args.includes('status'))console.log(fs.existsSync(home+'/signed-in')?'Logged in using ChatGPT':'Not logged in');
      else if(args[0]==='logout'){fs.rmSync(home+'/signed-in');process.exit(0);}
      else {console.log('Open https://auth.openai.com/codex/device\\nEnter code: ABCD-12345\\nPress Enter to continue.');console.log('sk-syntheticNeverLog01234567890');require('node:readline').createInterface({input:process.stdin}).on('line',()=>{fs.mkdirSync(home,{recursive:true});fs.writeFileSync(home+'/signed-in','synthetic marker');fs.writeFileSync(process.env.HOME+'/login-home',home);process.exit(0);});}
    `,
    );
    const env = { ...process.env, PATH: bin, HOME: root.home, CODEX_HOME: undefined };
    const registry = await openRegistry(join(root.home, "accounts.sqlite"), root.home);
    resources.own(() => registry.close());
    const catalog = new ModelCatalog({
      storage: openModelStorage(join(root.home, "models.sqlite")),
      now: () => 1000,
      deadline: () => () => {},
      instances: [
        {
          id: "codex-cli-default",
          provider: "codex",
          executable: join(bin, "codex"),
          cwd: root.home,
          loginRevision: "0",
        },
      ],
      discover: async (instance) =>
        normalizeCodex(
          {
            data: [
              {
                id: "fixture",
                model: instance.loginRevision === "0" ? "before-login" : "after-login",
                displayName: "Fixture",
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
    resources.own(() => catalog.close());
    await catalog.refresh();
    const statuses = new ProviderStatuses({ env }, { now: () => 1000, schedule: () => () => {} });
    resources.own(() => statuses.close());
    await statuses.refresh();
    let sequence = 0;
    const context: ServiceContext = {
      config: readConfig({ ACE_HOME: root.home, ACE_PORT: "0" }, root.home),
      options: { accounts: { env, discovery: { env } }, providerStatus: { env } },
      signal: new AbortController().signal,
      services: {
        accountRegistry: registry,
        accounts: new AccountService({ registry, env, now: () => 1000, timeZone: "UTC" }),
        models: catalog,
        providerStatuses: statuses,
      },
      resources,
      store: root.store,
      now: () => 1000,
      id: () => `login-${++sequence}`,
      log,
      onListen: [],
    };
    await startProviderLogin(context);
    if (!context.services.providerLogin || !context.services.onboarding)
      throw new Error("Provider login unavailable");
    server = await fixture({
      providerLogin: context.services.providerLogin,
      onboarding: context.services.onboarding,
      providerStatuses: statuses,
      models: catalog,
    });
    const device = server.store.devices.create("Phone", ["read", "operate"], 1000);
    const ticket = SocketTicket.parse(
      await accessRequest(server.server.httpUrl, "/v1/tickets", {
        method: "POST",
        token: device.token,
      }),
    );
    const client = await server.open();
    client.receiveCatalogPushes = true;
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(device.device.id),
      ticket: ticket.ticket,
    });
    await client.next();
    const seen: ServerMessage[] = [];
    client.send({ type: "onboarding.query", requestId: "first-run" });
    expect(
      await next(client, (message) => message.type === "onboarding.result", seen),
    ).toMatchObject({ result: { ready: [], next: { action: "sign_in", provider: "codex" } } });
    client.send({ type: "provider.login.start", requestId: "start", provider: "codex" });
    const start = await next(client, (message) => message.type === "provider.login.result", seen);
    if (start.type !== "provider.login.result" || !start.result.ok)
      throw new Error("Login not admitted");
    const session = start.result.progress.session;
    await next(
      client,
      (message) =>
        message.type === "provider.login.progress" &&
        message.progress.prompt === "Press Enter to continue.",
      seen,
    );
    client.send({
      type: "provider.login.input",
      requestId: "enter",
      session,
      input: { confirm: true },
    });
    await next(
      client,
      (message) =>
        message.type === "provider.login.progress" && message.progress.state === "succeeded",
      seen,
    );
    expect(await readFile(join(root.home, "login-home"), "utf8")).toBe(join(root.home, ".codex"));
    expect(registry.get("codex-cli-default")?.instance.loginRevision).toBe("1");
    expect(catalog.list().models.map((model) => model.nativeModelId)).toEqual(["after-login"]);
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "providers.changed",
          providers: expect.arrayContaining([
            expect.objectContaining({ provider: "codex", readiness: "signed_in" }),
          ]),
        }),
        expect.objectContaining({ type: "models.changed" }),
      ]),
    );
    expect(JSON.stringify([...seen, ...logs])).not.toContain("syntheticNeverLog");
    client.send({ type: "onboarding.dismiss", requestId: "dismiss", dismissed: true });
    expect(
      await next(client, (message) => message.type === "onboarding.result", seen),
    ).toMatchObject({
      result: { dismissed: true, ready: ["codex"], next: { action: "start_thread" } },
    });
    const reopened = new Onboarding(join(root.home, "onboarding.sqlite"), statuses);
    try {
      expect(reopened.query(device.device.id, "restart")).toMatchObject({
        result: { dismissed: true },
      });
      expect(reopened.query("another-device", "other")).toMatchObject({
        result: { dismissed: false },
      });
    } finally {
      reopened.close();
    }
    client.send({ type: "provider.logout", requestId: "logout", provider: "codex" });
    await next(
      client,
      (message) =>
        message.type === "provider.login.progress" &&
        message.progress.action === "logout" &&
        message.progress.state === "succeeded",
      seen,
    );
    expect(statuses.list().find((row) => row.provider === "codex")).toMatchObject({
      readiness: "installed_signed_out",
    });
  } finally {
    await server?.close();
    await resources.close();
    await log.close();
    await root.close();
  }
});

test("read-only paired devices cannot start, inspect, or cancel provider login sessions", async () => {
  const f = await fixture();
  try {
    const device = f.store.devices.create("Reader", ["read"], 1000);
    const ticket = SocketTicket.parse(
      await accessRequest(f.server.httpUrl, "/v1/tickets", { method: "POST", token: device.token }),
    );
    const client = await f.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(device.device.id),
      ticket: ticket.ticket,
    });
    await client.next();
    for (const request of [
      { type: "provider.login.start", requestId: "start", provider: "codex" },
      { type: "provider.login.poll", requestId: "poll", session: "secret-challenge" },
      { type: "provider.login.cancel", requestId: "cancel", session: "secret-challenge" },
    ] as const) {
      client.send(request);
      expect(await client.next()).toMatchObject({
        type: "provider.login.result",
        result: { ok: false, error: "forbidden" },
      });
    }
  } finally {
    await f.close();
  }
});
