import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnProvider, ScriptedTurnConfig } from "@ace/adapter-testkit";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { Automation, DeviceId, type AutomationRequest } from "@ace/protocol";
import { Client } from "./socket-test-support.ts";
import { scriptedModelInstance, seedScriptedModels } from "./testing/models.ts";

/** Real daemon, SQLite, sockets and timers; only the provider CLI is scripted. */
export async function idleDaemon() {
  const home = await mkdtemp(join(tmpdir(), "ace-idle-automation-"));
  const prompts: string[] = [];
  const registry = new AdapterRegistry();
  registry.register(
    createTurnProvider({
      provider: "codex",
      reply: "Scheduled task completed",
      config: ScriptedTurnConfig.parse({}),
      now: Date.now,
      respond(text) {
        prompts.push(text);
        return { kind: "reply", text: "Scheduled task completed", delayMs: 0 };
      },
      schedule(delay, callback) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    }),
    { installed: true, auth: "logged_in", loginHint: "scripted" },
  );
  const boot = () =>
    startDaemon({
      config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
      engine: { registry },
      modelInstances: [],
      providerStatus: {
        env: { ...process.env, PATH: "" },
        versions: async () => ({}),
        cursorSdk: async () => ({ installed: false, auth: "unknown", loginHint: "unused" }),
      },
    });
  let daemon = await boot();
  let stopped = false;
  const clients = new Set<Client>();
  let sequence = 0;
  const prepare = async () => {
    await seedScriptedModels(daemon.models, scriptedModelInstance("codex", home));
    await daemon.settings.set("access.defaultMode", "full-access", { kind: "global" });
  };
  await prepare();
  const workspace = daemon.store.createWorkspace(home, "Idle automation test");
  if (daemon.store.listThreads().length) throw new Error("Daemon must start with no threads");
  await daemon.settings.set("automations.enabled", true, { kind: "global" });
  const disconnect = async () => {
    for (const client of clients) await client.close();
    clients.clear();
  };
  return {
    prompts,
    get daemon() {
      return daemon;
    },
    definition(id: string, startAt: number) {
      return Automation.parse({
        id,
        title: id,
        enabled: true,
        workspace,
        provider: "codex",
        model: "chosen-model",
        access: "full-access",
        prompt: `Execute ${id} without an open client`,
        worktree: false,
        trigger: {
          kind: "schedule",
          schedule: {
            kind: "rrule",
            expression: "FREQ=MINUTELY;COUNT=1",
            timezone: "UTC",
            startAt,
          },
        },
        missedRun: "run_once",
        concurrency: 1,
        jitterMs: 0,
      });
    },
    async connect() {
      const client = new Client(daemon.url);
      clients.add(client);
      await once(client.socket, "open");
      client.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: DeviceId.parse(`idle-test-${++sequence}`),
        token: await readFile(daemon.tokenPath, "utf8"),
      });
      if ((await client.next()).type !== "welcome") throw new Error("Daemon authentication failed");
      return {
        async ask(request: AutomationRequest) {
          client.send(request);
          for (;;) {
            const response = await client.next();
            if (response.type === "automation.result" && response.requestId === request.requestId)
              return response;
          }
        },
      };
    },
    disconnect,
    async stop() {
      await disconnect();
      await daemon.close();
      stopped = true;
    },
    async restart() {
      if (!stopped) {
        await disconnect();
        await daemon.close();
      }
      daemon = await boot();
      stopped = false;
      await prepare();
    },
    async close() {
      await disconnect();
      if (!stopped) await daemon.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
