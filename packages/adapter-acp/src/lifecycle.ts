import { finalizeTool } from "./tool-final.ts";
import { retireTool } from "./completed-tools.ts";
import { cancellationDeadline, shellSurvivesPrompt } from "./settlement.ts";
import type { Fact } from "@ace/core";
import { string, type Data } from "./data.ts";
import { TranslationState, type AgentState } from "./state.ts";
import { toolDetail } from "./tools.ts";
import { placeholderChild } from "./children.ts";
/** Stop reasons where the agent was cut off by a limit rather than finishing its answer. */
const cutOff: Record<string, string> = {
  max_tokens: "The agent stopped early: it reached its output token limit.",
  max_turn_requests:
    "The agent stopped early: it reached its limit of model requests for one turn.",
};
export function endPrompt(
  s: TranslationState,
  agent: AgentState,
  reason: string,
  error: Data,
  now: number,
  facts: Fact[],
): void {
  s.promptOpen = false;
  agent.suspended = false;
  const cancelled = reason === "cancelled";
  for (const tool of s.liveTools) {
    if (!["pending", "running", "awaiting_approval"].includes(tool.status)) continue;
    if (tool.owner !== agent && !cancelled) continue;
    const detail = toolDetail(tool.data, s.quirks);
    // A failed prompt (an error reply, reason "") or a shell that never started survives nothing.
    if (detail.kind === "shell" && shellSurvivesPrompt(s.quirks.provider, reason, tool.status)) {
      if (!tool.task) {
        tool.task = s.key("background");
        facts.push({
          type: "background.started",
          agent: tool.owner.key,
          task: tool.task,
          kind: "shell",
          title: string(tool.data["title"]),
          item: tool.key,
          stoppable: false,
          // ace's ACP session takes no new prompt while this shell survives (ADR 0109).
          blocksPrompts: true,
          raw: [...tool.raw],
        });
      }
      if (!cancelled) continue;
      s.retainUncertainShell(tool);
      facts.push({ type: "background.ended", task: tool.task, status: "unknown", uncertain: true });
    }
    // A placeholder child has no native session, so no update can end it after its parent's turn.
    if (!cancelled && tool.child && !tool.child.terminal && !tool.child.placeholder) continue;
    const finalDetail = finalizeTool(tool, s.quirks);
    tool.status = "cancelled";
    s.liveTools.delete(tool);
    facts.push({
      type: "item.upsert",
      agent: tool.owner.key,
      item: tool.key,
      draft: {
        type: "tool_call",
        complete: true,
        call: {
          status: "cancelled",
          error: "turn ended without completion",
          detail: finalDetail,
          raw: [...tool.raw],
        },
      },
    });
    if (tool.child?.placeholder) placeholderChild(s, tool, facts);
    retireTool(s, tool);
  }
  // A stray session (no subagent association) has nothing else to end it: it ends here, as the
  // session's routing stops counting it at the same reply.
  if (agent === s.root)
    for (const child of s.agents.values()) {
      if (child === s.root || child.associated || child.placeholder || child.terminal) continue;
      if (child.active) s.end(child, facts, cancelled || !reason ? "interrupted" : "completed");
      child.terminal = true;
      s.disarmCancel(child);
    }
  let cancelling = false;
  if (cancelled)
    for (const child of s.agents.values())
      if (child !== s.root && !child.terminal) {
        s.armCancel(child, cancellationDeadline(now));
        cancelling = true;
      }
  if (cancelling)
    facts.push({ type: "wake.expected", agent: agent.key, until: cancellationDeadline(now) });
  for (const [id, request] of s.requests)
    if (cancelled || request.owner === agent) {
      facts.push({ type: "interaction.closed", interaction: request.key, state: "cancelled" });
      s.requests.delete(id);
    }
  const classified =
    s.quirks.classifyError(agent.segment) ??
    (reason === "refusal"
      ? // ACP `refusal` is the model declining, not an exhausted account.
        { kind: "provider" as const, code: "refusal", message: "Provider refused the prompt" }
      : undefined) ??
    (Object.keys(error).length
      ? {
          kind: error["code"] === -32000 ? ("auth" as const) : ("provider" as const),
          message: string(error["message"]) || "ACP prompt failed",
        }
      : undefined);
  s.end(agent, facts, cancelled ? "interrupted" : classified ? "failed" : "completed", classified);
  const limit = classified ? undefined : cutOff[reason];
  if (limit)
    facts.push({
      type: "item.upsert",
      agent: agent.key,
      item: s.key("stop"),
      draft: { type: "notice", complete: true, level: "warning", code: reason, text: limit },
    });
}

/**
 * Work after the root's prompt answered opens an implicit turn; it ends, completed, once no tool
 * of the root is still running outside a background task, as the session's input gate sees it.
 */
export function settleImplicitTurn(s: TranslationState, facts: Fact[]): void {
  const root = s.root;
  if (!root.implicitTurn) return;
  if (s.promptOpen || !root.active) {
    delete root.implicitTurn;
    return;
  }
  for (const tool of s.liveTools) if (tool.owner === root && !tool.task) return;
  delete root.implicitTurn;
  s.end(root, facts, "completed");
}
