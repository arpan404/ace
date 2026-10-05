import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach } from "vitest";
import { FakeHeadless } from "@ace/browser/testing";
import { createLogger } from "@ace/diagnostics";
import { SettingsService } from "@ace/settings";
import { SocketTicket, Agent, Command, type Interaction, type PermissionMode } from "@ace/protocol";
import { Store } from "./store.ts";
import { createDevThread, stubHandler } from "./commands.ts";
import { startBrowser } from "./services/browser.ts";
import { readyServices } from "./services/composition.ts";
import { Resources } from "./services/resources.ts";
import type { ServiceContext } from "./services/types.ts";
import { startServer } from "./server.ts";
import { BrowserClient } from "./browser-test-client.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
export async function originFixture(
  mode: PermissionMode = "ask",
  existingHome?: string,
  headless = new FakeHeadless(),
  navigationClock?: import("@ace/browser").NavigationClock,
) {
  const home = existingHome ?? (await mkdtemp(join(tmpdir(), "ace-origins-")));
  if (!existingHome) cleanup.push(() => rm(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"));
  const resources = new Resources();
  resources.own(() => store.close());
  const settings = new SettingsService({ dataDir: home });
  resources.own(() => settings.close());
  const log = createLogger({
    now: () => 1000,
    redact: (line) => line,
    level: "silent",
    sink: { async write() {}, async close() {} },
  });
  resources.own(() => log.close());
  let id = 0;
  const context: ServiceContext = {
    config: {
      dataDir: home,
      host: "127.0.0.1",
      port: 0,
      remotePort: 0,
      listen: "local",
      logLevel: "silent",
    },
    options: {
      browser: {
        headlessBackend: headless,
        ...(navigationClock ? { navigationClock } : {}),
        ffmpeg: "/nonexistent/ffmpeg",
      },
    },
    store,
    now: () => 1000,
    id: () => `origin-${++id}`,
    log,
    resources,
    signal: new AbortController().signal,
    services: { settings, handler: stubHandler({ now: () => 1000 }) },
    onListen: [],
  };
  await startBrowser(context);
  readyServices(context.services);
  const handler = context.services.handler;
  const browser = context.services.browser;
  if (!browser) throw new Error("Browser unavailable");
  const workspace =
    store.listThreads()[0]?.workspaceId ?? store.createWorkspace(home, "Origins", 1000);
  const thread = store.listThreads()[0] ?? createDevThread(store, workspace);
  store.appendEvents(thread.id, [
    { type: "thread.updated", permission: { override: mode, effective: mode, pending: false } },
  ]);
  if (!thread.rootAgentId)
    store.appendEvents(thread.id, [
      {
        type: "agent.created",
        agent: Agent.parse({
          id: `root-${thread.id}`,
          threadId: thread.id,
          parentId: null,
          origin: "root",
          native: { provider: "codex" },
          fidelity: "full",
          cwd: home,
          status: { state: "working", activity: "tool" },
          createdAt: 1000,
        }),
      },
    ]);
  const server = await startServer({
    port: 0,
    token: "a".repeat(64),
    hostId: "host",
    store,
    handler,
    browser,
    settings,
    canReadThread: (device) => device !== "excluded",
  });
  const clients: BrowserClient[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const client of clients) await client.close();
    await server.close();
    await resources.close();
  };
  cleanup.push(close);
  const client = async (credential = "a".repeat(64), device = "owner") => {
    const connection = new BrowserClient(server.url);
    clients.push(connection);
    await once(connection.socket, "open");
    const authentication =
      credential === "a".repeat(64)
        ? { token: credential }
        : SocketTicket.parse(
            await (
              await fetch(`${server.httpUrl}/v1/tickets`, {
                method: "POST",
                headers: { Authorization: `Bearer ${credential}` },
              })
            ).json(),
          );
    connection.send({ type: "hello", protocolVersion: 1, deviceId: device, ...authentication });
    await connection.next((message) => message.type === "welcome");
    return connection;
  };
  await browser.open({ threadId: thread.id, workspaceId: workspace });
  return {
    home,
    store,
    thread,
    browser,
    headless,
    settings,
    context,
    client,
    close,
    navigation: (url = "https://youtube.com/watch?v=local-test") =>
      browser.execute(thread.id, { action: "navigate", url }),
    opened: () =>
      new Promise<Interaction>((resolve) => {
        const stop = store.subscribe((events) => {
          for (const event of events)
            if (event.payload.type === "interaction.opened") {
              stop();
              resolve(event.payload.interaction);
            }
        });
      }),
    resolve: (interaction: Interaction, optionId: string) => {
      const command = Command.parse({
        id: `answer-${++id}`,
        deviceId: "owner",
        payload: {
          type: "interaction.resolve",
          interactionId: interaction.id,
          resolution: { kind: "approval", optionId },
        },
      });
      return store.recordCommand(command.id, command.deviceId, () =>
        handler.handle(command, store),
      );
    },
  };
}
