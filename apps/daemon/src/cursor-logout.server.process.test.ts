import { mkdir, mkdtemp, readFile, rm, writeFile, realpath, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
const hostBoundary = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, homedir: () => hostBoundary.home || os.homedir() };
});
import { startDaemon, AdapterRegistry } from "@ace/daemon";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { Command, DeviceId, type ServerMessage } from "@ace/protocol";
import { Client } from "./socket-test-support.ts";
import { z } from "zod";

const AgentStatusRow = z.object({
  payload: z
    .string()
    .transform((text): unknown => JSON.parse(text))
    .pipe(z.object({ status: z.object({ state: z.string() }) })),
});

// Stands in for the SDK host at its JSON-RPC boundary. Auth methods act on the SDK's own store
// file in the instance home, as `Cursor.auth.status()`/`logout()` do; sessions record their
// opens and closes. A `refuse-logout` marker makes sign-out fail the way the real host reports it.
const sdkBoundary = `
import { createInterface } from 'node:readline';
import { access, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
const home = process.env.HOME;
const store = join(home, '.cursor', 'sdk', 'auth.json');
const exists = (path) => access(path).then(() => true, () => false);
const reply = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line', async line => {
  const request = JSON.parse(line);
  let result;
  if (request.method === 'open') { await appendFile(join(home, 'session-opens'), 'x'); result = {agentId:'sdk-agent'}; }
  else if (request.method === 'close') { await appendFile(join(home, 'session-closes'), 'x'); result = {disposed:true}; }
  else if (request.method === 'status') result = (await exists(store)) ? {status:'logged-in',source:'sdk-store'} : {status:'logged-out',source:'none'};
  else if (request.method === 'logout') {
    if (await exists(join(home, 'refuse-logout')))
      return reply({id:request.id,error:{code:-32603,message:'Cursor SDK operation failed; check safe lifecycle notice',data:{code:'discovery_failed'}}});
    await rm(store, {force:true}); result = {status:'logged-out',source:'none'};
  }
  else if (request.method === 'send') result = {runId:'offline-run'};
  else result = {disposed:true};
  reply({id:request.id,result});
});`;

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Condition was not reached");
}

async function withCursorDaemon(
  options: { refuseLogout: boolean },
  body: (harness: {
    daemon: Awaited<ReturnType<typeof startDaemon>>;
    user: string;
    store: string;
    startThread(text: string): Promise<void>;
    opens(): Promise<string>;
    signOut(): Promise<ServerMessage>;
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-logout-")));
  hostBoundary.home = root;
  const user = join(root, "daemon", "instances", "cursor-sdk-default", "user");
  const store = join(user, ".cursor", "sdk", "auth.json");
  const entry = join(root, "sdk-boundary.mjs");
  await writeFile(entry, sdkBoundary);
  await mkdir(join(user, ".cursor", "sdk"), { recursive: true, mode: 0o700 });
  await writeFile(store, "{}", { mode: 0o600 });
  if (options.refuseLogout) await writeFile(join(user, "refuse-logout"), "");
  const registry = new AdapterRegistry();
  registry.register(
    {
      provider: "cursor",
      backend: "cursor-sdk",
      capabilities: () => cursorCapabilities,
      createTranslator: (init) => new CursorTranslator(init),
      async openSession() {
        throw new Error("Default SDK bypassed accounts ownership");
      },
    },
    { installed: true, auth: "unknown", loginHint: "offline" },
  );
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let client: Client | undefined;
  let threads = 0;
  try {
    const { readConfig } = await import("./config.ts");
    const started = await startDaemon({
      config: {
        ...readConfig({ ACE_HOME: join(root, "daemon") }, root),
        dataDir: join(root, "daemon"),
        host: "127.0.0.1",
        port: 0,
        remotePort: 0,
        listen: "local",
        logLevel: "silent",
      },
      modelInstances: [],
      engine: {
        registry,
        threadId: () => `cursor-thread-${threads}`,
        cursor: {
          env: {},
          entry,
          policy: "full-access",
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
    });
    daemon = started;
    const workspaceId = started.store.createWorkspace(root, "Cursor workspace");
    const opens = () => readFile(join(user, "session-opens"), "utf8").catch(() => "");
    const token = await readFile(started.tokenPath, "utf8");
    const socket = new Client(started.url);
    client = socket;
    await once(socket.socket, "open");
    socket.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("cli"), token });
    await socket.next();
    await body({
      daemon: started,
      user,
      store,
      opens,
      async startThread(text) {
        const before = (await opens()).length;
        threads++;
        const command = Command.parse({
          id: `create-${threads}`,
          deviceId: "device",
          payload: {
            type: "thread.create",
            provider: "cursor",
            access: "full-access",
            workspaceId,
            input: [{ type: "text", text }],
          },
        });
        expect(started.engine?.handler.handle(command, started.store)).toMatchObject({ ok: true });
        await started.engine?.flush();
        // The thread's SDK host is open and its run has not ended, so it holds the account.
        await until(async () => ((await opens()).length > before ? true : undefined));
      },
      async signOut() {
        socket.send({ type: "provider.logout", requestId: "logout", provider: "cursor" });
        for (;;) {
          const message = await socket.next();
          if (
            message.type === "provider.login.progress" &&
            ["succeeded", "failed", "cancelled"].includes(message.progress.state)
          )
            return message;
          if (message.type === "provider.login.result" && !message.result.ok) return message;
        }
      },
    });
  } finally {
    await client?.close();
    await daemon?.close();
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
}

it("signing out of Cursor while a thread holds the account stops that thread and reports signed out", async () => {
  await withCursorDaemon({ refuseLogout: false }, async ({ daemon, user, store, ...cursor }) => {
    await cursor.startThread("keep working");
    expect(await cursor.signOut()).toMatchObject({
      type: "provider.login.progress",
      progress: { action: "logout", state: "succeeded" },
    });
    await expect(access(store)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(user, "session-closes"), "utf8")).toBe("x");
    // The stopped thread is interrupted, never shown as done.
    const statuses = daemon.store.atomic((db) =>
      db
        .prepare("SELECT payload FROM events WHERE type = 'agent.status' ORDER BY seq")
        .all()
        .map((row) => AgentStatusRow.parse(row).payload.status.state),
    );
    expect(statuses.at(-1)).toBe("interrupted");
    expect(statuses).not.toContain("completed");
    expect(
      await daemon.cursorAuth?.handle("device", {
        type: "cursor.auth.status",
        requestId: "status",
        instanceId: "cursor-sdk-default",
      }),
    ).toMatchObject({ auth: { status: "logged-out", source: "none" } });
  });
});

it("a Cursor sign-out the SDK refuses says so and leaves the account signed in for new threads", async () => {
  await withCursorDaemon({ refuseLogout: true }, async ({ store, ...cursor }) => {
    await cursor.startThread("first");
    const result = await cursor.signOut();
    expect(result).toMatchObject({
      type: "provider.login.progress",
      progress: { action: "logout", state: "failed" },
    });
    expect(result.type === "provider.login.progress" && result.progress.message).toMatch(
      /Cursor's SDK didn't finish signing out/,
    );
    await access(store);
    await cursor.startThread("second");
    expect(await cursor.opens()).toBe("xx");
  });
});
