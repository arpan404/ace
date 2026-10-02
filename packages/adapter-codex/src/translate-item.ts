import type { Fact } from "@ace/core";
import type { Frame } from "@ace/engine-api";
import { itemDraft, toolDraft } from "./item.ts";
import {
  asyncKey,
  childKey,
  list,
  obj,
  questions,
  raw,
  shellKey,
  str,
  type Obj,
} from "./native.ts";
import type { Agent, TranslationContext } from "./translator-state.ts";
export function translateItem(
  agent: Agent,
  native: string,
  p: Obj,
  method: string,
  frame: Frame,
  now: number,
  ctx: TranslationContext,
  facts: Fact[],
): void {
  const { agents, tasks, discover, note } = ctx;
  facts.push({ type: "retry.cleared", agent: agent.key });
  const item = obj(p["item"]);
  const itemId = str(item["id"]);
  const type = str(item["type"]);
  const complete = method === "item/completed";
  if (!itemId) {
    facts.push(note(agent.key, method, frame.data));
    return;
  }
  agent.items.add(itemId);
  if (type === "subAgentActivity") {
    const child = str(item["agentThreadId"]);
    if (item["kind"] === "started" && child) {
      facts.push({
        type: "item.upsert",
        agent: agent.key,
        item: itemId,
        draft: toolDraft(
          { kind: "agent.spawn", childAgent: child },
          `Spawn ${str(item["agentPath"])}`,
          item,
          "succeeded",
          type,
        ),
      });
      const childAgent = discover(child, item, facts, now, native, itemId);
      const task = childKey(child);
      if (childAgent.turn || !childAgent.hadTurn) {
        tasks.add(task);
        facts.push({
          type: "background.started",
          agent: agent.key,
          task,
          kind: "subagent",
          childAgent: childAgent.key,
          item: itemId,
          title: str(item["agentPath"], child),
          stoppable: true,
        });
      }
    } else if (item["kind"] === "completed") {
      facts.push(note(agent.key, type, item, `${str(item["agentPath"], child)} finished`));
      if (!agent.turn) agent.childResult = true;
    } else facts.push(note(agent.key, type, item));
  } else {
    if (type === "collabAgentToolCall" && item["tool"] === "spawnAgent") {
      for (const receiver of list(item["receiverThreadIds"])) {
        const child = str(receiver);
        if (!child) continue;
        const childAgent = discover(child, item, facts, now, native, itemId);
        const task = childKey(child);
        if (childAgent.turn || !childAgent.hadTurn) {
          tasks.add(task);
          facts.push({
            type: "background.started",
            agent: agent.key,
            task,
            childAgent: childAgent.key,
            item: itemId,
            kind: "subagent",
            title: str(item["prompt"], "Subagent"),
            stoppable: true,
          });
        }
      }
    }
    const previous = agent.open.get(itemId);
    if (!complete) {
      // Canonical core state retains the exact raw start; replay metadata excludes growing output.
      const { aggregatedOutput: _output, ...metadata } = item;
      agent.open.set(itemId, {
        data: metadata,
        turn: str(p["turnId"], agent.turn),
      });
    } else {
      agent.open.delete(itemId);
      agent.completed.add(itemId);
    }
    const draft = itemDraft(item, complete);
    if (type === "plan" && previous?.streamStarted && complete)
      facts.push({
        type: "item.upsert",
        agent: agent.key,
        item: `codex:plan-stream:${itemId}`,
        draft: { type: "notice", complete: true },
      });
    if (previous && complete) {
      const earlier = raw(
        str(previous.data["type"]),
        previous.data,
        previous.data["tool"] ?? previous.data["name"],
      );
      if (draft.type === "tool_call" && draft.call)
        draft.call.raw = [...earlier, ...(draft.call.raw ?? [])];
      else if (draft.type === "message" || draft.type === "reasoning" || draft.type === "notice")
        draft.raw = [...earlier, ...(draft.raw ?? [])];
    }
    if (draft.type === "tool_call" && draft.call?.detail?.kind === "shell") {
      if (typeof item["aggregatedOutput"] === "string")
        draft.call.detail.output = item["aggregatedOutput"];
      facts.push({ type: "item.reconciled", agent: agent.key, item: itemId, draft });
    } else facts.push({ type: "item.upsert", agent: agent.key, item: itemId, draft });
    if (!complete && type === "collabAgentToolCall" && item["tool"] === "wait")
      facts.push({
        type: "subagents.waiting",
        agent: agent.key,
        item: itemId,
        targets: list(item["receiverThreadIds"]).filter(
          (value): value is string => typeof value === "string",
        ),
      });
    if (complete && type === "commandExecution") {
      tasks.delete(shellKey(itemId));
      facts.push({
        type: "background.ended",
        task: shellKey(itemId),
        status: item["status"] === "failed" ? "failed" : "completed",
      });
      agent.backgroundResult = true;
    }
    if (
      type === "agentMessage" &&
      complete &&
      /^(?:error:\s*)?(?:You(?:’|')ve hit your usage limit|Your usage limit has been reached|Rate limit reached|Authentication failed|Not logged in)/i.test(
        str(item["text"]),
      )
    )
      agent.failureText = str(item["text"]);
    if (type === "plan" && complete) agent.plan = { id: itemId, text: str(item["text"]) };
    if (
      type === "agentMessage" &&
      item["delivery"] === "async" &&
      list(item["questions"]).length &&
      !agent.async.has(itemId)
    ) {
      agent.async.add(itemId);
      ctx.asyncOwners.set(asyncKey(itemId), { agent, item: itemId });
      facts.push({
        type: "interaction.opened",
        agent: agent.key,
        interaction: asyncKey(itemId),
        item: itemId,
        blocking: false,
        request: { kind: "question", questions: questions(item["questions"], true) },
        raw: raw(type, item),
      });
    }
    if (!complete && type !== "userMessage")
      facts.push({
        type: "activity",
        agent: agent.key,
        activity:
          type === "reasoning"
            ? "thinking"
            : type === "agentMessage" || type === "plan"
              ? "responding"
              : type === "contextCompaction"
                ? "compacting"
                : "tool",
      });
    if (type === "collabAgentToolCall" && item["tool"] !== "wait")
      for (const child of list(item["receiverThreadIds"])) {
        const target = agents.get(str(child));
        if (target) target.pendingTrigger = "parent_agent";
      }
  }
}
