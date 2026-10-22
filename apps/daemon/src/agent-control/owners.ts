import { logError } from "@ace/diagnostics";
import { followAutomationSetting } from "../automation-lifecycle.ts";
import { AgentPreviews } from "./previews.ts";
export { AgentPreviews } from "./previews.ts";
import { createHandoffs } from "./handoffs.ts";
import { createOffshifts } from "./offshift.ts";
import { createThreadAutomations } from "./thread-automations.ts";
import { join } from "node:path";
import { z } from "zod";
import { AutomationService, AutomationStore } from "@ace/automations";
import {
  AgentId,
  ThreadId,
  type AgentControlResult,
  type AgentAutomation,
  type Automation,
  type AutomationRequest,
  type McpAttribution,
} from "@ace/protocol";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "./delegations.ts";
import { ownerThreadExecutor } from "./owner-thread-executor.ts";
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
    onError: (error) => log.log("error", "Agent automation failed", logError(error)),
    executor: ownerThreadExecutor(context, (automationId) => lookup(automationId)?.thread_id),
  });
  resources.own(() => automations.stop());
  resources.onShutdown(() => automations.stop());
  context.onListen.push(() => followAutomationSetting(context, automations));
  const live = (automationId: string) => {
    const identity = lookup(automationId);
    const thread = identity && store.getThread(identity.thread_id);
    return thread && thread.deletedAt === undefined ? thread.id : undefined;
  };
  const threadAutomations = createThreadAutomations(automations, live);
  const previews = new AgentPreviews();
  const handoffs = createHandoffs(context, delegations);
  const offshifts = createOffshifts(context, delegations);
  return {
    previews,
    threadAutomations,
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
        case "offshift":
          return offshifts.execute(caller, operation, signal);
        case "automation.manage": {
          const request = operation.request;
          if (request.type === "automation.list") {
            // Each automation the caller may see, with when it runs next and how it last went.
            const listed = automations.handle({
              type: "automation.list",
              requestId: request.requestId,
            });
            const schedules = new Map(
              (listed.schedules ?? []).map((schedule) => [schedule.id, schedule]),
            );
            return {
              ok: true,
              data: (listed.automations ?? [])
                .filter((job) => {
                  const identity = lookup(job.id);
                  return identity && delegations.authorize(caller, identity.thread_id, true);
                })
                .map((job) => {
                  const schedule = schedules.get(job.id);
                  const lastRun = schedule?.lastRun;
                  return Object.assign(
                    {},
                    job,
                    { nextRunAt: schedule?.nextRunAt ?? null },
                    lastRun ? { lastRun: { status: lastRun.status, at: lastRun.startedAt } } : {},
                  );
                }),
            };
          }
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
          // Owner confinement covers pause/resume and retry: setEnabled and retry
          // carry only an id, so the same lookup/authorize gate applies as remove/run.
          const identity = lookup(automationId);
          if (identity && !delegations.authorize(caller, identity.thread_id, true))
            return { ok: false, code: "forbidden" };
          if (!identity && request.type !== "automation.put")
            return { ok: false, code: "not_found" };
          let full: AutomationRequest | undefined =
            request.type === "automation.put" ? undefined : request;
          if (request.type === "automation.put") {
            const thread = store.getThread(caller.threadId);
            if (!thread) throw new Error("Caller missing");
            const path = store.getWorkspacePath(thread.workspaceId);
            if (!path) return { ok: false, code: "unavailable" };
            const draft = request.automation;
            // Agent jobs run in the caller's project and thread, without worktrees or jitter.
            // The thread is where each run lands, so its provider is the automation's, always.
            const definition: Automation = {
              ...draft,
              trigger: completeTrigger(
                draft.trigger,
                now(),
                new Intl.DateTimeFormat().resolvedOptions().timeZone,
              ),
              workspace: draft.workspace ?? path,
              provider: thread.provider,
              worktree: false,
              jitterMs: 0,
            };
            if (definition.workspace !== path || draft.worktree || (draft.jitterMs ?? 0) !== 0)
              return { ok: false, code: "unsupported" };
            store.atomic((db) => {
              // Ownership tombstones protect historical and interrupted runs.
              // AutomationStore caps live definitions; this claim and put never yield.
              db.prepare("INSERT OR IGNORE INTO agent_automation_owners VALUES (?,?,?)").run(
                automationId,
                caller.threadId,
                caller.agentId,
              );
            });
            full = { ...request, automation: definition };
          }
          if (!full) return { ok: false, code: "invalid" };
          const result = automations.handle(full);
          return { ok: result.ok, data: result };
        }
        default:
          return { ok: false, code: "unsupported" };
      }
    },
  };
}

/**
 * An agent's trigger with its schedule filled in: the machine's time zone and a start of now,
 * to the minute, where the agent named only the rule.
 */
export function completeTrigger(
  trigger: AgentAutomation["trigger"],
  now: number,
  localZone: string,
): Automation["trigger"] {
  if (trigger.kind === "manual") return trigger;
  const { schedule } = trigger;
  return {
    kind: "schedule",
    schedule: {
      ...schedule,
      timezone: schedule.timezone ?? localZone,
      startAt: schedule.startAt ?? Math.floor(now / 60_000) * 60_000,
    },
  };
}
