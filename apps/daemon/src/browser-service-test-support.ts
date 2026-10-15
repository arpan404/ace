import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { FakeHeadless } from "@ace/browser/testing";
import { createLogger } from "@ace/diagnostics";
import { SettingsService } from "@ace/settings";
import { Agent, Command, type Interaction, type AccessMode } from "@ace/protocol";
import { Store } from "./store.ts";
import { createDevThread, stubHandler } from "./commands.ts";
import { startBrowser } from "./services/browser.ts";
import { readyServices } from "./services/composition.ts";
import { Resources } from "./services/resources.ts";
import type { ServiceContext } from "./services/types.ts";

const cleanup: (() => Promise<void>)[] = [];
/** Command ids stay unique across a restart over the same store, so answers aren't replayed. */
let fixtures = 0;
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
export async function browserFixture(
  mode: AccessMode = "ask",
  existingHome?: string,
  headless = new FakeHeadless(),
) {
  const run = ++fixtures;
  const home = existingHome ?? (await mkdtemp(join(tmpdir(), "ace-browser-service-")));
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
      browser: { headlessBackend: headless, ffmpeg: "/nonexistent/ffmpeg" },
    },
    store,
    now: () => 1000,
    id: () => `browser-${++id}`,
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
    store.listThreads()[0]?.workspaceId ?? store.createWorkspace(home, "Browser", 1000);
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
  cleanup.push(() => resources.close());
  await browser.open({ threadId: thread.id, workspaceId: workspace });
  return {
    home,
    store,
    thread,
    browser,
    headless,
    context,
    /** Answers an interaction through the daemon's composed command port, as a client would. */
    resolve: (interaction: Interaction, optionId: string) => {
      const command = Command.parse({
        id: `answer-${run}-${++id}`,
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
