import type { Fact } from "@ace/core";
import { itemDraft } from "./item.ts";
import { turnError } from "./interactions.ts";
import { childKey, planKey, raw, shellKey, str, obj, type Obj } from "./native.ts";
import type { Agent, TranslationContext } from "./translator-state.ts";
export function completeTurn(
  agent: Agent,
  native: string,
  p: Obj,
  ctx: TranslationContext,
  facts: Fact[],
): void {
  const { agents, tasks } = ctx;
  const turn = obj(p["turn"]);
  const turnId = str(turn["id"]);
  agent.hadTurn = true;
  const current = !agent.turn || agent.turn === turnId;
  const outcome =
    current && agent.failureText
      ? "failed"
      : turn["status"] === "interrupted"
        ? "interrupted"
        : turn["status"] === "failed"
          ? "failed"
          : "completed";
  for (const [itemId, open] of agent.open) {
    if (open.turn !== turnId) continue;
    if (open.data["type"] === "commandExecution") {
      const task = shellKey(itemId);
      tasks.add(task);
      facts.push({
        type: "background.started",
        agent: agent.key,
        task,
        kind: "shell",
        title: str(open.data["command"]),
        item: itemId,
        stoppable: true,
        raw: raw("commandExecution", open.data),
      });
    } else {
      if (open.streamStarted)
        facts.push({
          type: "item.upsert",
          agent: agent.key,
          item: `codex:plan-stream:${itemId}`,
          draft: { type: "notice", complete: true },
        });
      const draft = itemDraft(open.data, true);
      if (draft.type === "tool_call" && draft.call)
        draft.call.status = outcome === "completed" ? "succeeded" : "cancelled";
      facts.push({ type: "item.upsert", agent: agent.key, item: itemId, draft });
      agent.open.delete(itemId);
    }
  }
  if (agent.ended.has(turnId)) return;
  agent.ended.add(turnId);
  if (current)
    for (const child of agent.children) {
      const childAgent = agents.get(child);
      if (
        childAgent?.turn ||
        (childAgent &&
          (!childAgent.hadTurn ||
            [...childAgent.open.keys()].some((item) => tasks.has(shellKey(item)))))
      )
        facts.push({ type: "agent.linked", agent: childAgent.key, background: true });
    }
  for (const [key, request] of agent.requests)
    if (request.turn === turnId) {
      facts.push({ type: "interaction.closed", interaction: key, state: "cancelled" });
      agent.requests.delete(key);
    }
  facts.push({
    type: "turn.ended",
    agent: agent.key,
    nativeTurnId: turnId,
    outcome,
    ...(outcome === "failed"
      ? {
          error: turnError(
            current && agent.failureText ? { message: agent.failureText } : turn["error"],
          ),
        }
      : {}),
  });
  if (agent.turn === turnId) delete agent.turn;
  if (current && agent.parent && tasks.has(childKey(native))) {
    tasks.delete(childKey(native));
    facts.push({
      type: "background.ended",
      task: childKey(native),
      status: outcome === "failed" ? "failed" : "completed",
    });
  }
  if (current && outcome === "completed" && agent.mode === "plan" && agent.plan)
    facts.push({
      type: "interaction.opened",
      agent: agent.key,
      interaction: planKey(turnId),
      item: agent.plan.id,
      blocking: true,
      request: { kind: "plan_review", markdown: agent.plan.text },
      raw: raw("plan", agent.plan),
    });
}
