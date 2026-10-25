import {
  Command,
  ItemId,
  RunId,
  type AgentControlOperation,
  type AgentControlResult,
  type McpAttribution,
  type ThreadForkOperation,
  type ThreadId,
} from "@ace/protocol";
import type { Store } from "../store.ts";
import { controlCommandId } from "./command-id.ts";
import { conversationAnswer } from "./conversation-answer.ts";
import type { ConversationJournal } from "./conversation-journal.ts";
import type { DelegationService } from "./delegations.ts";

type MergeOperation = Extract<AgentControlOperation, { op: "thread.merge" }>;

/** The newest finished run of a thread's root agent: where a fork without a runId starts. */
function latestFinishedRun(store: Store, threadId: ThreadId): RunId | undefined {
  const root = store.getThread(threadId)?.rootAgentId;
  if (!root) return undefined;
  const row = store.atomic((db) =>
    db
      .prepare(
        `SELECT id FROM view_entities WHERE thread_id=? AND collection='runs'
        AND json_extract(value,'$.agentId')=? AND json_extract(value,'$.state')<>'active'
        AND json_extract(value,'$.endedAt') IS NOT NULL
        ORDER BY json_extract(value,'$.endedAt') DESC LIMIT 1`,
      )
      .get(threadId, root),
  );
  return row ? RunId.parse(row.id) : undefined;
}

/**
 * The fork's latest assistant answer: what a merge cites when the agent names no items. The
 * answers it copied from its source when it was made are not its own work.
 */
function latestAnswer(store: Store, threadId: ThreadId): ItemId | undefined {
  const row = store.atomic((db) =>
    db
      .prepare(
        `SELECT id FROM items WHERE thread_id=? AND json_extract(item,'$.type')='message'
        AND json_extract(item,'$.role')='assistant' AND json_extract(item,'$.inherited') IS NULL
        ORDER BY created_seq DESC LIMIT 1`,
      )
      .get(threadId),
  );
  return row ? ItemId.parse(row.id) : undefined;
}

/**
 * Forks and merge-backs an agent asks for, as the person's own fork and merge commands run them.
 * A fork is the caller's: it can message, settle and merge it like a thread it started.
 */
export function createForks(
  store: Store,
  service: DelegationService,
  journal: ConversationJournal,
) {
  const answer = (threadId: ThreadId): AgentControlResult => {
    const thread = store.getThread(threadId);
    if (!thread) return { ok: true, data: { threadId } };
    const account = thread.execution?.instanceId ?? thread.live?.account;
    const started = conversationAnswer(thread, service.accountLabel(account));
    return {
      ok: true,
      data: { ...started, summary: started.summary.replace(/^Started/, "Forked") },
    };
  };

  async function fork(
    caller: McpAttribution,
    operation: ThreadForkOperation,
    signal?: AbortSignal,
  ): Promise<AgentControlResult> {
    const previous = journal.receipt(caller, operation.requestId);
    if (previous)
      return JSON.stringify(previous.request) === JSON.stringify(operation)
        ? answer(previous.threadId)
        : { ok: false, code: "invalid", hint: "That requestId was used for another call." };
    const source = store.getThread(operation.threadId);
    if (!source) return { ok: false, code: "not_found" };
    const runId = operation.runId ?? latestFinishedRun(store, operation.threadId);
    if (!runId)
      return {
        ok: false,
        code: "not_ready",
        hint: "The thread has no finished turn to fork from yet; fork it once a turn ends.",
      };
    const budget = operation.model ? service.loadBudget(signal) : undefined;
    let selection;
    try {
      selection =
        operation.model && budget
          ? await service.threadSelection(
              caller,
              source,
              operation.requestId,
              operation.model,
              { effort: operation.effort },
              budget,
            )
          : undefined;
    } finally {
      budget?.end();
    }
    // A call cancelled while its model lists loaded starts no fork.
    signal?.throwIfAborted();
    const command = Command.parse({
      id: controlCommandId(caller.threadId, operation.requestId, "thread.fork"),
      deviceId: "ace-agent",
      payload: {
        type: "thread.fork",
        threadId: source.id,
        point: { type: "turn", runId },
        input: operation.text,
        ...(operation.title ? { title: operation.title } : {}),
        ...(selection ? { selection: { options: {}, ...selection } } : {}),
      },
    });
    const result = await service.transition(command);
    if (!result.ok || !result.forkThreadId) return refused(result.error);
    const forkId = result.forkThreadId;
    store.atomic(() => {
      const root = service.journal.tree(caller.threadId, service.now()).root;
      service.journal.enroll(forkId, root);
      journal.add({
        threadId: forkId,
        ownerThreadId: caller.threadId,
        ownerAgentId: caller.agentId,
        rootId: root,
        createdAt: service.now(),
        request: operation,
      });
      store.appendEvents(forkId, [
        { type: "thread.client.updated", changes: { hasSentMessage: true } },
      ]);
    });
    return answer(forkId);
  }

  async function merge(caller: McpAttribution, operation: MergeOperation) {
    const forked = store.getThread(operation.threadId);
    const parentId = forked?.lineage?.parentThreadId;
    if (!forked || !parentId)
      return {
        ok: false,
        code: "invalid",
        hint: "Only a fork merges back, into the thread it was forked from; this thread is not a fork.",
      } as const;
    if (!service.authorize(caller, parentId, true))
      return {
        ok: false,
        code: "forbidden",
        hint: "You cannot change the thread this was forked from.",
      } as const;
    if (!["done", "failed", "new"].includes(forked.status.state))
      return {
        ok: false,
        code: "not_ready",
        hint: "The fork is still working. Call wait with its threadId, then merge it.",
      } as const;
    const items = operation.itemIds ?? [latestAnswer(store, forked.id)].filter((id) => !!id);
    if (!items.length)
      return {
        ok: false,
        code: "not_ready",
        hint: "The fork has no answer to merge yet; pass itemIds from thread_read.",
      } as const;
    const result = await service.transition(
      Command.parse({
        id: controlCommandId(caller.threadId, operation.requestId, "thread.merge"),
        deviceId: "ace-agent",
        payload: {
          type: "thread.merge",
          threadId: forked.id,
          summary: operation.summary,
          citations: items.map((itemId) => ({ threadId: forked.id, itemId })),
        },
      }),
    );
    if (!result.ok) return refused(result.error);
    const parent = store.getThread(parentId);
    return {
      ok: true,
      data: {
        mergedInto: parentId,
        ...(parent ? { title: parent.title } : {}),
        summary: `Merged the fork's result into “${parent?.title ?? "its source thread"}”; its agent sees it from its next turn.`,
      },
    } as const;
  }

  return { fork, merge };
}

/** The engine's refusal, as an agent can act on it. */
function refused(error: string | undefined): AgentControlResult {
  switch (error) {
    case "fork_tree_is_live":
    case "source_tree_is_live":
    case "thread_transition_in_progress":
      return {
        ok: false,
        code: "not_ready",
        hint: "A thread involved is still working or changing; wait for it, then retry.",
      };
    case "provider_unavailable":
    case "provider_options_unsupported":
      return { ok: false, code: "unavailable", hint: "That provider cannot run the fork now." };
    case "engine_capacity_exceeded":
      return { ok: false, code: "limit", hint: "ace is at its thread limit; retry shortly." };
    default:
      return {
        ok: false,
        code: "invalid",
        hint: error ? `ace refused it (${error}).` : "ace refused it.",
      };
  }
}
