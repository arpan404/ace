import { randomUUID } from "node:crypto";
import { SettingsService } from "@ace/settings";
import { createLogger } from "@ace/diagnostics";
import type { McpAttribution } from "@ace/protocol";
import { readConfig } from "../config.ts";
import { end } from "../engine/test-support.ts";
import { Resources } from "../services/resources.ts";
import type { ServiceContext } from "../services/types.ts";
import { createAgentOwners } from "./owners.ts";
import { ownerThreadExecutor } from "./owner-thread-executor.ts";
import type { ExtensionOperation } from "./tools.ts";
import { setup } from "./test-support.ts";

/**
 * Real ownership, settings, delegation and SQLite; only the provider CLI is scripted. With
 * `claude`, the automations' thread is a Claude thread: each turn stays open until the test
 * answers it (`answer`), where a Codex turn ends as soon as it starts.
 */
export async function automationFixture(provider: "codex" | "claude" = "codex") {
  const h = setup();
  const caller = provider === "claude" ? await claudeThread(h) : await h.parent();
  let sequence = 0;
  const open = async () => {
    const resources = new Resources();
    const settings = new SettingsService({ dataDir: h.home });
    resources.own(() => settings.close());
    const log = createLogger({
      now: h.clock.now,
      level: "silent",
      redact: (line) => line,
      sink: { async write() {}, async close() {} },
    });
    resources.own(() => log.close());
    const onListen: (() => void | Promise<void>)[] = [];
    const context = {
      config: readConfig({ ACE_HOME: h.home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
      signal: new AbortController().signal,
      options: { engine: { registry: h.registry, clock: h.clock } },
      store: h.store,
      now: h.clock.now,
      id: () => `automation-${++sequence}`,
      resources,
      log,
      // Runs go into the agent's own thread through the engine, as in the daemon.
      services: { settings, engine: h.engine },
      onListen,
    } satisfies ServiceContext;
    const owners = createAgentOwners(context, h.service);
    for (const listen of onListen) await listen();
    return { resources, settings, owners, context };
  };
  let owner = await open();
  return {
    h,
    caller,
    /** Where the agent automations' own store lives. */
    get dataDir() {
      return owner.context.config.dataDir;
    },
    /** An executor for automations made from the fixture's thread, driven directly. */
    executor() {
      return ownerThreadExecutor(owner.context, h.service, () => ({
        thread_id: caller.threadId,
        agent_id: caller.agentId,
      }));
    },
    /** The agent ends the thread's open turn with `text`, once it has taken `turn` inputs. */
    async answer(turn: number, item: string, text: string) {
      for (let i = 0; i < 200 && (h.inputs.get(caller.threadId)?.length ?? 0) < turn; i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      await h.emit(
        caller.threadId,
        {
          type: "item.upsert",
          agent: "root",
          item,
          draft: {
            type: "message",
            role: "assistant",
            parts: [{ type: "text", text }],
            complete: true,
          },
        },
        end,
      );
    },
    get settings() {
      return owner.settings;
    },
    call(operation: ExtensionOperation, identity: McpAttribution = caller) {
      return owner.owners.execute(identity, operation, new AbortController().signal);
    },
    async restart() {
      await owner.resources.close();
      owner = await open();
    },
    async close() {
      await owner.resources.close();
      for (const context of h.contexts.values()) context.onFrame(h.frames.frame(end));
      await h.engine.flush();
      await h.close();
    },
  };
}

/** A Claude thread for automations to run in, in the harness's workspace. */
async function claudeThread(h: ReturnType<typeof setup>): Promise<McpAttribution> {
  const codex = await h.parent();
  const workspaceId = h.store.getThread(codex.threadId)?.workspaceId;
  if (!workspaceId) throw new Error("Missing workspace");
  const result = h.service.command(randomUUID(), {
    type: "thread.create",
    workspaceId,
    provider: "claude",
    access: "full-access",
    input: [{ type: "text", text: "plan" }],
  });
  if (!result.ok || !result.threadId) throw new Error(result.error ?? "Creation failed");
  await h.engine.flush();
  for (let i = 0; i < 200 && !h.inputs.get(result.threadId)?.length; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  await h.complete(result.threadId, "Planned");
  return h.caller(result.threadId);
}
