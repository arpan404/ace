import type { Fact } from "@ace/core";
import type { Frame } from "@ace/engine-api";
import { itemDraft } from "./item.ts";
import { str, type Obj } from "./native.ts";
import type { Agent, TranslationContext } from "./translator-state.ts";
const deltas = new Map<string, "text" | "reasoning" | "output">([
  ["item/agentMessage/delta", "text"],
  ["item/reasoning/summaryTextDelta", "reasoning"],
  ["item/reasoning/textDelta", "reasoning"],
  ["item/commandExecution/outputDelta", "output"],
]);
export function isKnownDelta(method: string): boolean {
  return deltas.has(method) || method === "item/plan/delta";
}
export function translateDelta(
  agent: Agent,
  p: Obj,
  method: string,
  frame: Frame,
  ctx: TranslationContext,
  facts: Fact[],
): void {
  const item = str(p["itemId"]);
  const append = str(p["delta"]);
  const field = deltas.get(method);
  if (!item || (!field && method !== "item/plan/delta")) {
    facts.push(ctx.note(agent.key, method, frame.data));
    return;
  }
  facts.push({ type: "retry.cleared", agent: agent.key });
  let open = agent.open.get(item);
  if (method === "item/plan/delta" || field === "output") {
    if (!open && !agent.completed.has(item)) {
      open = {
        data: {
          id: item,
          type: field === "output" ? "commandExecution" : "plan",
          command: "",
          commandActions: [],
          text: "",
        },
        turn: str(p["turnId"], agent.turn),
        output: 0,
      };
      agent.open.set(item, open);
      agent.items.add(item);
      facts.push({
        type: "item.upsert",
        agent: agent.key,
        item,
        draft: itemDraft(open.data, false),
      });
    }
    if (method === "item/plan/delta") {
      if (!open) {
        facts.push(ctx.note(agent.key, method, frame.data));
        return;
      }
      const stream = `codex:plan-stream:${item}`;
      if (!open.streamStarted) {
        facts.push({
          type: "item.upsert",
          agent: agent.key,
          item: stream,
          draft: { type: "notice", level: "info", text: str(open.data["text"]), complete: false },
        });
        open.streamStarted = true;
      }
      facts.push({ type: "item.delta", agent: agent.key, item: stream, field: "text", append });
      return;
    }
    if (!open) {
      facts.push({ type: "item.delta", agent: agent.key, item, field: "output", append });
      return;
    }
    const draft = itemDraft(open.data, false);
    open.output += append.length;
    if (draft.type !== "tool_call" || draft.call?.kind !== "shell") {
      facts.push(ctx.note(agent.key, method, frame.data));
      return;
    }
  }
  if (field) facts.push({ type: "item.delta", agent: agent.key, item, field, append });
}
