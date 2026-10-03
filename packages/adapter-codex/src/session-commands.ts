import type { ProviderSession } from "@ace/engine-api";
import type { ContentPart, AgentLaunchOptions } from "@ace/protocol";
import type { ServerRequest } from "@ace/provider-kit/jsonrpc";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.ts";
import type { ThreadQueueAddParams } from "./generated/v2/ThreadQueueAddParams.ts";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.ts";
import type { ThreadBackgroundTerminalsListParams } from "./generated/v2/ThreadBackgroundTerminalsListParams.ts";
import type { ThreadBackgroundTerminalsTerminateParams } from "./generated/v2/ThreadBackgroundTerminalsTerminateParams.ts";
import { childKey, list, obj, shellKey, str } from "./native.ts";
import { approvalResult } from "./resolution.ts";
import { nativeInput as input } from "./native-input.ts";
export type Pending = {
  request: ServerRequest;
  answer(value: unknown): void;
  reject(error: Error): void;
};
export type SessionCommandsContext = {
  nativeSessionId: string;
  launchOptions?: AgentLaunchOptions;
  active: Map<string, string>;
  parents: Map<string, string>;
  shells: Map<string, string>;
  pending: Map<string, Pending>;
  asyncQuestions: Map<string, string>;
  plans: Map<string, { thread: string; markdown: string }>;
  assertOpen(): void;
  request(method: string, params: unknown, interactive?: boolean): Promise<unknown>;
  emit(dir: "send" | "recv" | "stderr" | "note", data: unknown, channel?: string): void;
  getModel(): string;
  userMessageId(): string;
  refreshQueue(threadId: string): Promise<void>;
};
export function createSessionCommands(
  config: SessionCommandsContext,
): Omit<ProviderSession, "nativeSessionId" | "close"> {
  const {
    nativeSessionId,
    active,
    parents,
    shells,
    pending,
    asyncQuestions,
    plans,
    assertOpen,
    request,
    emit,
  } = config;
  async function sendTo(
    threadId: string,
    parts: ContentPart[],
    delivery: "steer" | "queue",
  ): Promise<void> {
    assertOpen();
    const turn = active.get(threadId);
    if (turn && delivery === "queue") {
      await request("thread/queue/add", {
        threadId,
        input: input(parts),
        clientUserMessageId: config.userMessageId(),
      } satisfies ThreadQueueAddParams);
      await config.refreshQueue(threadId);
    } else if (turn)
      await request(
        "turn/steer",
        { threadId, expectedTurnId: turn, input: input(parts) } satisfies TurnSteerParams,
        true,
      );
    else {
      await request(
        "turn/start",
        {
          threadId,
          input: input(parts),
          ...(config.launchOptions?.effort ? { effort: config.launchOptions.effort } : {}),
          ...(config.launchOptions?.serviceTier
            ? { serviceTier: config.launchOptions.serviceTier }
            : {}),
        } satisfies TurnStartParams,
        true,
      );
    }
  }
  async function stopShells(threadId: string, itemId?: string): Promise<void> {
    let cursor: unknown = undefined;
    const processIds: string[] = [];
    do {
      const result = obj(
        await request("thread/backgroundTerminals/list", {
          threadId,
          ...(cursor ? { cursor: str(cursor) } : {}),
        } satisfies ThreadBackgroundTerminalsListParams),
      );
      for (const terminal of list(result["data"])) {
        const t = obj(terminal);
        if (!itemId || t["itemId"] === itemId) processIds.push(str(t["processId"]));
      }
      cursor = result["nextCursor"];
    } while (cursor);
    if (itemId && !processIds.length) throw new Error("Background terminal is no longer listed");
    for (const processId of processIds)
      await request(
        "thread/backgroundTerminals/terminate",
        { threadId, processId } satisfies ThreadBackgroundTerminalsTerminateParams,
        true,
      );
  }
  async function interruptOne(thread: string, cascade: boolean): Promise<void> {
    const failures: unknown[] = [];
    const turnId = active.get(thread);
    if (turnId)
      try {
        await request(
          "turn/interrupt",
          { threadId: thread, turnId } satisfies TurnInterruptParams,
          true,
        );
      } catch (error) {
        failures.push(error);
      }
    if (cascade)
      try {
        await stopShells(thread);
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(failures, `Could not completely interrupt Codex thread ${thread}`);
  }
  async function interruptTree(thread: string, cascade: boolean): Promise<void> {
    const targets = new Set([thread]);
    if (cascade)
      for (const [child] of parents) {
        let parent = parents.get(child);
        const seen = new Set<string>();
        while (parent && !seen.has(parent)) {
          if (parent === thread) {
            targets.add(child);
            break;
          }
          seen.add(parent);
          parent = parents.get(parent);
        }
      }
    const failures: unknown[] = [];
    for (const id of targets)
      try {
        await interruptOne(id, cascade);
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(failures, "Could not completely interrupt Codex agent tree");
  }
  return {
    send: (parts, delivery) => sendTo(nativeSessionId, parts, delivery),
    async interrupt(target) {
      assertOpen();
      const thread = !target.agent || target.agent === "root" ? nativeSessionId : target.agent;
      await interruptTree(thread, target.cascade);
    },
    async stopTask(task: string) {
      assertOpen();
      if (task.startsWith("subagent:")) {
        await interruptTree(task.slice(childKey("").length), true);
        return;
      }
      const item = task.startsWith("shell:") ? task.slice(shellKey("").length) : task;
      const thread = shells.get(item);
      if (!thread) throw new Error("Unknown Codex background task");
      await stopShells(thread, item);
    },
    async resolve(key, resolution) {
      assertOpen();
      const entry = pending.get(key);
      if (entry) {
        const result = approvalResult(entry.request, resolution);
        pending.delete(key);
        entry.answer(result);
        return;
      }
      const thread = asyncQuestions.get(key);
      if (thread && resolution.kind === "question") {
        const text = resolution.dismissed
          ? "Continue without answers."
          : Object.values(resolution.answers)
              .map((answers) => answers.join(", "))
              .join("; ");
        await sendTo(thread, [{ type: "text", text }], "steer");
        asyncQuestions.delete(key);
        emit("note", { event: "interaction-resolved", interaction: key });
        return;
      }
      const plan = plans.get(key);
      if (plan && resolution.kind === "plan_review") {
        if (
          resolution.decision !== "cancel" &&
          (resolution.decision === "approve" || resolution.feedback)
        )
          await request(
            "turn/start",
            {
              threadId: plan.thread,
              input: input([
                {
                  type: "text",
                  text:
                    resolution.decision === "approve"
                      ? "Implement the plan."
                      : (resolution.feedback ?? ""),
                },
              ]),
              collaborationMode: {
                mode: resolution.decision === "approve" ? "default" : "plan",
                settings: {
                  model: config.getModel(),
                  reasoning_effort: null,
                  developer_instructions: null,
                },
              },
            } satisfies TurnStartParams,
            true,
          );
        plans.delete(key);
        emit("note", { event: "interaction-resolved", interaction: key });
        return;
      }
      throw new Error("Unknown or already resolved Codex interaction");
    },
  };
}
