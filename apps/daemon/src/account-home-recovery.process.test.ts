import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, test } from "vitest";
import { createInstance, openRegistry } from "@ace/accounts";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { DeviceId, type ClientMessage } from "@ace/protocol";
import { prepareDaemonHome } from "@ace/service";
import { startDaemon, AdapterRegistry } from "@ace/daemon";
import { readConfig } from "./config.ts";
import { Client } from "./socket-test-support.ts";
import { createManagedHome } from "./account-homes.ts";
import { cursorSdkDiscovery } from "./testing/cursor-sdk-discovery.ts";

test.each([
  ["default", "sign in"],
  ["managed", "sign in"],
  ["default", "remove"],
  ["managed", "remove"],
])("a %s Cursor account with a missing folder can %s", async (kind, action) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-account-home-recovery-")));
  const dataDir = join(root, "daemon");
  prepareDaemonHome(dataDir);
  const id = kind === "default" ? "cursor-sdk-default" : "account-work";
  const instance =
    kind === "managed"
      ? await createManagedHome(dataDir, id, "cursor", "Work")
      : createInstance({
          id,
          provider: "cursor",
          label: "Cursor",
          homeDir: join(dataDir, "instances", id),
        });
  await mkdir(instance.homeDir, { recursive: true });
  const saved = await openRegistry(join(dataDir, "accounts.sqlite"));
  await saved.register(instance);
  saved.close();
  await rm(instance.homeDir, { recursive: true });
  const entry = join(root, "sdk-boundary.mjs");
  await writeFile(
    entry,
    `
import {createInterface} from 'node:readline';
import {mkdir,writeFile,access,rm} from 'node:fs/promises';
import {join} from 'node:path';
const marker=join(process.env.HOME,'signed-in');
createInterface({input:process.stdin}).on('line',async line=>{
 const request=JSON.parse(line);
 if(request.method==='login') {
  await mkdir(process.env.HOME,{recursive:true});
  await writeFile(marker,'fixture sign-in');
 } else if(request.method==='logout') await rm(marker,{force:true});
 const signedIn=await access(marker).then(()=>true,()=>false);
 const result=['login','logout','status'].includes(request.method)
  ? {status:signedIn?'logged-in':'logged-out',source:signedIn?'sdk-store':'none'}
  : request.method==='models'?[]:{disposed:true};
 console.log(JSON.stringify({id:request.id,result}));
});`,
  );
  const adapters = new AdapterRegistry();
  adapters.register(
    {
      provider: "cursor",
      backend: "cursor-sdk",
      capabilities: () => cursorCapabilities,
      createTranslator: (init) => new CursorTranslator(init),
      async openSession() {
        throw new Error("No sessions in this fixture");
      },
    },
    { installed: true, auth: "unknown", loginHint: "offline" },
  );
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let client: Client | undefined;
  try {
    daemon = await startDaemon({
      config: readConfig({ ACE_HOME: dataDir, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }, root),
      modelInstances: [],
      accounts: { env: { HOME: root } },
      engine: { registry: adapters, cursor: { entry, env: {}, discovery: cursorSdkDiscovery } },
    });
    const socket = new Client(daemon.url);
    client = socket;
    await once(socket.socket, "open");
    socket.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("recovery"),
      token: await readFile(daemon.tokenPath, "utf8"),
    });
    await socket.next();
    const request = async (message: ClientMessage) => {
      socket.send(message);
      for (;;) {
        const response = await socket.next();
        if (
          "requestId" in response &&
          "requestId" in message &&
          response.requestId === message.requestId
        )
          return response;
      }
    };
    expect(
      await request({ type: "accounts.status", requestId: "before", instanceId: id }),
    ).toMatchObject({
      account: { quota: { blockers: { homeUnavailable: "home_missing" } } },
    });
    if (action === "sign in") {
      const started = await request({
        type: "provider.login.start",
        requestId: "login",
        provider: "cursor",
        instance: id,
        method: "login",
      });
      if (started.type !== "provider.login.result" || !started.result.ok)
        throw new Error(JSON.stringify(started));
      const session = started.result.progress.session;
      await expect
        .poll(
          async () => {
            const progress = await request({
              type: "provider.login.poll",
              requestId: "poll",
              session,
            });
            return progress.type === "provider.login.result" && progress.result.ok
              ? progress.result.progress.state
              : progress;
          },
          { timeout: 10000 },
        )
        .toBe("succeeded");
      expect(
        await request({ type: "accounts.status", requestId: "after", instanceId: id }),
      ).toMatchObject({
        account: { availability: "available", quota: { auth: "logged_in", blockers: {} } },
      });
      return;
    }
    const result = await request({
      type: "provider.accounts.remove",
      requestId: "remove",
      provider: "cursor",
      instanceId: id,
      confirm: true,
      deleteHome: false,
    });
    expect(result).toMatchObject({ type: "provider.accounts.result", result: { ok: true } });
    expect(
      await request({ type: "accounts.status", requestId: "removed", instanceId: id }),
    ).toMatchObject({ account: null });
  } finally {
    await client?.close();
    await daemon?.close();
    await adapters.close();
    await rm(root, { recursive: true, force: true });
  }
});
