import type { CommandPayload, ProviderKind, ThreadId } from "@ace/protocol";
import { ThreadId as ThreadIdSchema } from "@ace/protocol";
import type { ServiceContext } from "../../services/types.ts";
import type { TransferArchive, TransferGit } from "../ports.ts";
import { TransferError } from "../ports.ts";
import type { ThreadOwnership } from "./ownership.ts";
import type { LiveResumes } from "./resumes.ts";
import type { LiveSourcePorts } from "./source.ts";
import type { LiveTargetPorts } from "./target.ts";
import { LiveStarts } from "./target-rows.ts";

/*
 * ADR 0191's live move, bound to this daemon's engine, agent control, terminals and accounts.
 * Thin: every decision is in source.ts, target.ts and the pure modules beside them.
 */

const id = (value: string): ThreadId => ThreadIdSchema.parse(value);

function engineOf({ services }: ServiceContext) {
  const engine = services.engine;
  if (!engine) throw new TransferError("engine_unavailable", "Agents are starting here.");
  return engine;
}

/** A command as ace's own agent control sends it, keyed so a repeat runs once. */
function command(context: ServiceContext, key: string, payload: CommandPayload): void {
  const delegations = context.services.agentControl?.delegations;
  if (!delegations) throw new TransferError("not_ready", "Agent control is not ready");
  const result = delegations.command(key, payload);
  if (!result.ok) throw new TransferError("not_delivered", result.error ?? "refused");
}

function send(context: ServiceContext, threadId: string, key: string, text: string): void {
  command(context, key, {
    type: "thread.send",
    threadId: id(threadId),
    input: [{ type: "text", text }],
    delivery: "queue",
  });
}

/** The account a provider's threads use here, and its home. */
function account(context: ServiceContext, provider: ProviderKind, instanceId?: string) {
  const registry = context.services.accountRegistry;
  const chosen = instanceId ?? registry?.selectedProvider(provider) ?? `${provider}-cli-default`;
  const home = registry?.get(chosen)?.instance.homeDir;
  return home ? { instanceId: chosen, home } : undefined;
}

export function liveSourcePorts(
  context: ServiceContext,
  input: {
    ownership: ThreadOwnership;
    git: TransferGit;
    archive: TransferArchive;
    resumes: LiveResumes;
    sleep(ms: number, signal: AbortSignal): Promise<void>;
  },
): LiveSourcePorts {
  const { services, store, now } = context;
  return {
    ownership: input.ownership,
    git: input.git,
    archive: input.archive,
    session(threadId) {
      const thread = store.getThread(id(threadId));
      if (!thread) return undefined;
      let meta: ReturnType<ReturnType<typeof engineOf>["sessionMetadata"]>;
      try {
        meta = engineOf(context).sessionMetadata(id(threadId));
      } catch {
        return undefined;
      }
      const home = account(context, thread.provider, meta.instanceId)?.home;
      return {
        provider: thread.provider,
        cwd: meta.cwd,
        ...(meta.nativeSessionId ? { nativeSessionId: meta.nativeSessionId } : {}),
        ...(home ? { home } : {}),
      };
    },
    turnFacts: (threadId) => engineOf(context).liveMove.turnFacts(id(threadId)),
    interrupt: (threadId, key) =>
      command(context, key, { type: "thread.interrupt", threadId: id(threadId), cascade: false }),
    stopProvider: (threadId) => engineOf(context).liveMove.closeProvider(id(threadId)),
    shells: (threadId) => engineOf(context).liveMove.shells(id(threadId)),
    terminals: (threadId) =>
      (services.workspaceActions?.listTerminals(id(threadId)) ?? [])
        .filter((terminal) => !terminal.exited)
        .map((terminal) => terminal.name.slice(0, 256)),
    stopTerminals: async (threadId) => {
      await services.workspaceActions?.stopThreadTerminals(id(threadId));
    },
    // Every subagent thread of the tree here, at any depth, settled ones too: a settled child's
    // warm session is a provider process as well.
    descendants: (threadId) =>
      (services.agentControl?.delegations.journal.descendants(id(threadId)) ?? []).map((edge) => ({
        threadId: edge.childId,
        title: store.getThread(edge.childId)?.title ?? edge.childId,
        live: edge.phase !== "settled",
      })),
    withProcess: (threadIds) => engineOf(context).liveMove.withProcess(threadIds.map(id)),
    stopChild: (threadId, key) =>
      command(context, key, { type: "thread.interrupt", threadId: id(threadId), cascade: true }),
    remoteChildren(threadId) {
      try {
        return store
          .statement(
            "SELECT role FROM machine_children WHERE parent_thread=? AND settled=0 LIMIT 32",
          )
          .all(threadId)
          .map((row) => String(row["role"]).slice(0, 256));
      } catch {
        // No machine children were ever delegated here.
        return [];
      }
    },
    queued: (threadId) => engineOf(context).queue(id(threadId)).messages.length,
    hold(threadId, transferId, change) {
      const thread = store.getThread(id(threadId));
      if (!thread?.rootAgentId) return;
      engineOf(context).externalHold(
        id(threadId),
        thread.rootAgentId,
        `ace-transfer:${transferId}`,
        "title" in change ? change : { status: "completed" },
      );
    },
    moved: (threadId, to) =>
      engineOf(context).liveMove.markMoved(id(threadId), {
        hostId: to.hostId as never,
        name: to.name.slice(0, 256),
        threadId: id(to.threadId),
      }),
    released: (threadId) => engineOf(context).liveMove.released(id(threadId)),
    resume: (threadId, transferId, text) => input.resumes.owe(threadId, transferId, text),
    atomic: (run) => store.atomic(run),
    now,
    sleep: input.sleep,
  };
}

export function liveTargetPorts(
  context: ServiceContext,
  input: {
    ownership: ThreadOwnership;
    git: TransferGit;
    archive: TransferArchive;
    log(message: string, fields: Record<string, unknown>): void;
  },
): LiveTargetPorts {
  const { store, now } = context;
  return {
    starts: new LiveStarts(store),
    ownership: input.ownership,
    git: input.git,
    archive: input.archive,
    account: (provider) => account(context, provider),
    threadCwd(threadId) {
      try {
        return store.executionWorkspace(id(threadId))?.path;
      } catch {
        return undefined;
      }
    },
    threadStatus: (threadId) => store.getThread(id(threadId))?.status,
    adoptSession: (threadId, session) =>
      engineOf(context).liveMove.adoptSession(id(threadId), session),
    dropSession: (threadId) => engineOf(context).liveMove.dropSession(id(threadId)),
    adoptHandoff(threadId, handoff, machine) {
      const thread = store.getThread(id(threadId));
      if (!thread) return;
      engineOf(context).adoptMachineHandoff(id(threadId), {
        handoff,
        commandId: `transfer-live:${threadId}`,
        machine,
        to: {
          provider: thread.provider,
          ...(thread.execution?.model ? { model: thread.execution.model } : {}),
        },
        at: now(),
      });
    },
    send: (threadId, key, text) => send(context, threadId, key, text),
    notice: (threadId, text) =>
      engineOf(context).hostNotice(id(threadId), `transfer-live:${threadId}:start`, text, "error"),
    now,
    sleep: (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
      }),
    log: input.log,
  };
}

/** The durable resume after a failed move, sending through agent control as the person would. */
export function liveResumePorts(
  context: ServiceContext,
  input: {
    sleep(ms: number, signal: AbortSignal): Promise<void>;
    log(message: string, fields: Record<string, unknown>): void;
  },
): import("./resumes.ts").LiveResumePorts {
  return {
    store: context.store,
    send: (threadId, key, text) => send(context, threadId, key, text),
    status: (threadId) => context.store.getThread(id(threadId))?.status,
    now: context.now,
    sleep: input.sleep,
    log: input.log,
  };
}
