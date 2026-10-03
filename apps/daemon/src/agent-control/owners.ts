import { AgentPreviews } from "./previews.ts";
export { AgentPreviews } from "./previews.ts";
import { createHandoffs } from "./handoffs.ts";
import { join } from "node:path";
import { z } from "zod";
import { AutomationService, AutomationStore } from "@ace/automations";
import { AgentId, ThreadId, type AgentControlResult, type McpAttribution } from "@ace/protocol";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "./delegations.ts";
import type { ExtensionOperation } from "./tools.ts";

const owner = z.object({ thread_id: ThreadId, agent_id: AgentId });
export function createAgentOwners(context: ServiceContext, delegations: DelegationService) {
  const { store, config, now, id, resources, log } = context;
  store.atomic((db) =>
    db.exec(`CREATE TABLE IF NOT EXISTS agent_automation_owners (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), agent_id TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS agent_automation_thread ON agent_automation_owners(thread_id,id);`),
  );
  const lookup = (automationId: string) =>
    store.atomic((db) => {
      const row = db
        .prepare("SELECT thread_id,agent_id FROM agent_automation_owners WHERE id=?")
        .get(automationId);
      return row ? owner.parse(row) : undefined;
    });
  const attribution = (automationId: string): McpAttribution => {
    const identity = lookup(automationId);
    if (!identity) throw new Error("Automation owner missing");
    return {
      sessionId: `automation:${automationId}`,
      threadId: identity.thread_id,
      agentId: identity.agent_id,
    };
  };
  const automationStore = new AutomationStore(join(config.dataDir, "agent-automations.sqlite"));
  resources.own(() => automationStore.close());
  const clock = context.options.engine?.clock;
  const automations = new AutomationService(automationStore, {
    now,
    id,
    random: () => 0, // Agent-created jobs require zero jitter; no nondeterministic scheduling.
    timer: {
      arm: (delay, callback) =>
        clock
          ? clock.setTimer(() => {
              void callback();
            }, delay)
          : (() => {
              const timer = setTimeout(() => {
                void callback();
              }, delay);
              timer.unref();
              return () => clearTimeout(timer);
            })(),
    },
    onError: (error) => log.log("error", "Agent automation failed", error),
    executor: {
      async execute(input, signal) {
        const caller = attribution(input.automationId);
        if (input.worktree || input.prompt.length > 16384)
          throw new Error(
            "Use thread.handoff for worktrees; automation prompts must fit the delegation budget",
          );
        const child = delegations.delegate(caller, {
          requestId: input.idempotencyKey,
          task: input.prompt,
          role: `automation: ${input.automationId}`,
          provider: input.provider,
          ...(input.model ? { model: input.model } : {}),
          wait: false,
          estimatedLoad: 0,
        });
        const result = await delegations.wait(caller, child.childId, signal);
        return {
          threadId: child.childId,
          status: result.outcome === "completed" ? "succeeded" : "failed",
          result: result.result,
        };
      },
      async recover(key, signal) {
        // The durable automation run selects the owner, not any agent-supplied attribution.
        const active = automationStore.active().find((entry) => entry.input.idempotencyKey === key);
        if (!active) return undefined;
        const caller = attribution(active.input.automationId);
        const edge = delegations.journal.receipt(caller.threadId, key);
        if (!edge) return undefined;
        const result = await delegations.wait(caller, edge.childId, signal);
        return {
          threadId: edge.childId,
          status: result.outcome === "completed" ? "succeeded" : "failed",
          result: result.result,
        };
      },
    },
  });
  resources.own(() => automations.stop());
  resources.onShutdown(() => automations.stop());
  context.onListen.push(() => automations.start());
  const previews = new AgentPreviews();
  const handoffs = createHandoffs(context, delegations);
  return {
    previews,
    async execute(
      caller: McpAttribution,
      operation: ExtensionOperation,
      signal: AbortSignal,
    ): Promise<AgentControlResult> {
      signal.throwIfAborted();
      switch (operation.op) {
        case "preview.list":
          return { ok: true, data: previews.list(operation.threadId) };
        case "preview.close":
          return previews.close(operation.threadId, operation.previewId);
        case "thread.handoff":
          return handoffs.execute(caller, operation, signal);
        case "automation.manage": {
          const request = operation.request;
          if (request.type === "automation.list")
            return {
              ok: true,
              data: automations.list().filter((job) => {
                const identity = lookup(job.id);
                return identity && delegations.authorize(caller, identity.thread_id, true);
              }),
            };
          // Inbox paging is scoped by each job's durable ownership, before data is returned.
          if (request.type === "automation.inbox") {
            const page = automations.inbox(request.limit, request.before);
            return {
              ok: true,
              data: {
                ...page,
                runs: page.runs.filter((run) => {
                  const identity = lookup(run.automationId);
                  return identity && delegations.authorize(caller, identity.thread_id, true);
                }),
              },
            };
          }
          const automationId =
            request.type === "automation.put" ? request.automation.id : request.id;
          const identity = lookup(automationId);
          if (identity && !delegations.authorize(caller, identity.thread_id, true))
            return { ok: false, code: "forbidden" };
          if (!identity && request.type !== "automation.put")
            return { ok: false, code: "not_found" };
          if (request.type === "automation.put") {
            const path = store.getWorkspacePath(
              store.getThread(caller.threadId)?.workspaceId ??
                (() => {
                  throw new Error("Caller missing");
                })(),
            );
            const definition = request.automation;
            if (
              definition.workspace !== path ||
              definition.worktree ||
              definition.jitterMs !== 0 ||
              definition.prompt.length > 16384 ||
              !["manual", "schedule"].includes(definition.trigger.kind)
            )
              return { ok: false, code: "unsupported" };
            store.atomic((db) => {
              if (
                Number(db.prepare("SELECT COUNT(*) AS n FROM agent_automation_owners").get()?.n) >=
                  1000 &&
                !identity
              )
                throw new Error("Automation capacity");
              db.prepare("INSERT OR IGNORE INTO agent_automation_owners VALUES (?,?,?)").run(
                automationId,
                caller.threadId,
                caller.agentId,
              );
            });
          }
          const result = automations.handle(request);
          return { ok: result.ok, data: result };
        }
        default:
          return { ok: false, code: "unsupported" };
      }
    },
  };
}
