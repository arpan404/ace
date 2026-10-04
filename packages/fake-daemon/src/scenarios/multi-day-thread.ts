import {
  AgentId,
  DeviceId,
  InteractionId,
  ItemId,
  RunId,
  ThreadId,
  WorkspaceId,
  type EventPayload,
  type Item,
  type Thread,
} from "@ace/protocol";

export interface MultiDayThreadOptions {
  threadId?: string;
  workspaceId?: string;
  /** Total main-thread items. The iterator never retains earlier items. */
  items?: number;
  turns?: number;
  subagents?: number;
  startedAt?: number;
  durationMs?: number;
}

export interface SyntheticThreadEvent {
  threadId: ThreadId;
  at: number;
  payload: EventPayload;
}

const day = 24 * 60 * 60 * 1000;

/**
 * Streams a deterministic multi-day transcript. Defaults are one million items,
 * 2,000 approvals and turns, and 48 linked child threads. Consumers may seed a
 * store in bounded batches or feed a performance harness without a giant array.
 * No providers, clocks, filesystem operations or random numbers are involved.
 */
export function* multiDayThread(
  options: MultiDayThreadOptions = {},
): Generator<SyntheticThreadEvent> {
  const id = ThreadId.parse(options.threadId ?? "thread-multi-day");
  const workspaceId = WorkspaceId.parse(options.workspaceId ?? "multi-day-workspace");
  const itemCount = options.items ?? 1_000_000;
  const turns = options.turns ?? 2_000;
  const children = options.subagents ?? 48;
  const startedAt = options.startedAt ?? Date.UTC(2026, 8, 28);
  const duration = options.durationMs ?? 5 * day;
  if (
    !Number.isSafeInteger(itemCount) ||
    !Number.isSafeInteger(turns) ||
    !Number.isSafeInteger(children) ||
    turns < 1 ||
    itemCount < turns * 4 ||
    children < 0 ||
    children > turns ||
    startedAt < 0 ||
    duration <= 0
  )
    throw new Error("Invalid multi-day thread dimensions");
  const root = AgentId.parse(`${id}.root`);
  const thread: Thread = {
    id,
    workspaceId,
    title: "Five-day migration: checkpoints, approvals and worker reports",
    provider: "codex",
    status: { state: "new" },
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  yield { threadId: id, at: startedAt, payload: { type: "thread.created", thread } };
  yield {
    threadId: id,
    at: startedAt,
    payload: {
      type: "agent.created",
      agent: {
        id: root,
        threadId: id,
        parentId: null,
        origin: "root",
        native: { provider: "codex", nativeId: `${id}-session` },
        fidelity: "full",
        cwd: "/synthetic/workspace",
        status: { state: "idle" },
        background: false,
        createdAt: startedAt,
      },
    },
  };
  let emittedItems = 0;
  for (let ordinal = 1; ordinal <= turns; ordinal++) {
    const at = startedAt + Math.floor(((ordinal - 1) * duration) / turns);
    const endedAt = startedAt + Math.floor((ordinal * duration) / turns) - 1;
    const runId = RunId.parse(`${id}.run.${ordinal}`);
    const count = Math.floor(itemCount / turns) + (ordinal <= itemCount % turns ? 1 : 0);
    const envelope = (payload: EventPayload, time = at): SyntheticThreadEvent => ({
      threadId: id,
      at: time,
      payload,
    });
    const base = (number: number) => ({
      id: ItemId.parse(`${id}.item.${number}`),
      agentId: root,
      runId,
      createdAt: at + Math.floor(((number - emittedItems - 1) * (endedAt - at)) / count),
      complete: true,
    });
    const question: Item = {
      ...base(emittedItems + 1),
      type: "message",
      role: "user",
      parts: [
        { type: "text", text: `Migrate checkpoint ${ordinal}, inspect files and report failures.` },
      ],
      synthetic: false,
      raw: [],
    };
    yield envelope({ type: "item.created", item: question });
    yield envelope({
      type: "run.started",
      run: {
        id: runId,
        threadId: id,
        agentId: root,
        ordinal,
        trigger: "user",
        state: "active",
        startedAt: at,
      },
    });
    yield envelope({
      type: "agent.status",
      agentId: root,
      status: { state: "working", activity: "tool" },
    });
    yield envelope({ type: "thread.updated", status: { state: "working", agents: 1 } });
    const approvalId = InteractionId.parse(`${id}.approval.${ordinal}`);
    yield envelope({
      type: "interaction.opened",
      interaction: {
        id: approvalId,
        threadId: id,
        agentId: root,
        blocking: true,
        request: {
          kind: "approval",
          title: `Approve checkpoint ${ordinal}`,
          options: [{ id: "allow", label: "Allow once", kind: "allow_once" }],
        },
        state: "pending",
        createdAt: at,
        raw: [],
      },
    });
    yield envelope(
      {
        type: "interaction.closed",
        interactionId: approvalId,
        state: "resolved",
        resolution: { kind: "approval", optionId: "allow" },
        resolvedBy: DeviceId.parse("synthetic-device"),
        autoReviewed: ordinal % 3 === 0,
        closedAt: at + 1,
      },
      at + 1,
    );
    for (let local = 2; local <= count; local++) {
      const number = emittedItems + local;
      let item: Item;
      if (local === count) {
        item = {
          ...base(number),
          type: "message",
          role: "assistant",
          synthetic: false,
          raw: [],
          parts: [
            {
              type: "text",
              text: `Checkpoint ${ordinal} completed. Migration paths validated; ${ordinal % 11 === 0 ? "one command failed and was retried" : "all commands passed"}.`,
            },
          ],
        };
      } else if (local % 25 === 0) {
        const failed = ordinal % 11 === 0 && local === 50;
        const shell = local % 50 === 0;
        item = {
          ...base(number),
          type: "tool_call",
          call: {
            id: ItemId.parse(`${id}.item.${number}`),
            agentId: root,
            kind: shell ? "shell" : "file.edit",
            title: shell ? `Inspect checkpoint ${ordinal}` : `Edit src/module-${ordinal % 200}.ts`,
            status: failed ? "failed" : "succeeded",
            startedAt: at,
            endedAt,
            raw: [],
            detail: shell
              ? {
                  kind: "shell",
                  command: `git diff --check checkpoint-${ordinal}`,
                  exitCode: failed ? 1 : 0,
                }
              : {
                  kind: "file.edit",
                  changes: [
                    {
                      path: `src/module-${ordinal % 200}.ts`,
                      kind: "update",
                      diff: `@@ -1 +1,2 @@\n-old checkpoint\n+checkpoint ${ordinal}\n+verified migration\n`,
                    },
                  ],
                },
            ...(failed ? { error: "checkpoint validation failed" } : {}),
          },
        };
      } else if (local === 3) {
        item = {
          ...base(number),
          type: "reasoning",
          summary: false,
          raw: [],
          text: `Checkpoint ${ordinal}: blob-needle-${ordinal} ${"bounded streamed reasoning ".repeat(2600)}`,
        };
      } else {
        item = {
          ...base(number),
          type: "notice",
          level: local % 137 === 0 ? "error" : "info",
          text: `Migration checkpoint ${ordinal}, item ${number}: ${local % 137 === 0 ? "retryable scan error" : "examined dependency and retained original permissions"}.`,
          raw: [],
        };
      }
      yield envelope({ type: "item.created", item }, item.createdAt);
      if (local === 50 && item.type === "tool_call")
        yield envelope(
          {
            type: "item.delta",
            itemId: item.id,
            agentId: root,
            field: "output",
            append: `tool-output-needle-${ordinal}\n${"checkpoint scan output ".repeat(2000)}\nscan complete\n`,
          },
          item.createdAt,
        );
    }
    if (ordinal <= children) yield* childThread(id, root, workspaceId, ordinal, at, endedAt);
    yield envelope(
      {
        type: "usage.updated",
        agentId: root,
        inputTokens: 1_000,
        outputTokens: 400,
        counterMode: "incremental",
      },
      endedAt,
    );
    yield envelope({ type: "run.ended", runId, state: "completed", endedAt }, endedAt);
    yield envelope({ type: "agent.status", agentId: root, status: { state: "idle" } }, endedAt);
    yield envelope({ type: "thread.updated", status: { state: "done" } }, endedAt);
    emittedItems += count;
  }
}

function* childThread(
  parent: ThreadId,
  parentAgent: AgentId,
  workspaceId: WorkspaceId,
  ordinal: number,
  at: number,
  endedAt: number,
): Generator<SyntheticThreadEvent> {
  const id = ThreadId.parse(`${parent}.child.${ordinal}`);
  const agentId = AgentId.parse(`${id}.root`);
  const summaryId = AgentId.parse(`${parent}.worker.${ordinal}`);
  const thread: Thread = {
    id,
    workspaceId,
    title: `Worker ${ordinal}: audit migration shard`,
    provider: "codex",
    status: { state: "new" },
    createdAt: at,
    updatedAt: at,
    lineage: {
      parentThreadId: parent,
      parentAgentId: parentAgent,
      point: { type: "turn", runId: RunId.parse(`${parent}.run.${ordinal}`) },
      mode: "portable",
      lossy: false,
    },
  };
  const send = (payload: EventPayload): SyntheticThreadEvent => ({ threadId: id, at, payload });
  const agent = {
    id: agentId,
    threadId: id,
    parentId: null,
    origin: "root" as const,
    native: { provider: "codex" as const, nativeId: `${id}-session` },
    fidelity: "full" as const,
    cwd: "/synthetic/workspace",
    status: { state: "idle" as const },
    background: false,
    createdAt: at,
  };
  yield send({ type: "thread.created", thread });
  yield send({ type: "agent.created", agent });
  yield {
    threadId: parent,
    at,
    payload: {
      type: "agent.created",
      agent: {
        ...agent,
        id: summaryId,
        threadId: parent,
        parentId: parentAgent,
        childThreadId: id,
        origin: "ace",
        name: `Migration worker ${ordinal}`,
        status: { state: "working", activity: "thinking" },
      },
    },
  };
  const runId = RunId.parse(`${id}.run.1`);
  yield send({
    type: "run.started",
    run: {
      id: runId,
      threadId: id,
      agentId,
      ordinal: 1,
      trigger: "spawn",
      state: "active",
      startedAt: at,
    },
  });
  yield send({
    type: "item.created",
    item: {
      id: ItemId.parse(`${id}.message`),
      agentId,
      runId,
      createdAt: at,
      complete: true,
      type: "message",
      role: "assistant",
      synthetic: false,
      raw: [],
      parts: [
        { type: "text", text: `Worker ${ordinal} verified subagent-needle migration shard.` },
      ],
    },
  });
  yield {
    threadId: id,
    at: endedAt,
    payload: { type: "run.ended", runId, state: "completed", endedAt },
  };
  yield {
    threadId: id,
    at: endedAt,
    payload: { type: "agent.status", agentId, status: { state: "idle" } },
  };
  yield {
    threadId: id,
    at: endedAt,
    payload: { type: "thread.updated", status: { state: "done" } },
  };
  yield {
    threadId: parent,
    at: endedAt,
    payload: { type: "agent.status", agentId: summaryId, status: { state: "idle" } },
  };
}
