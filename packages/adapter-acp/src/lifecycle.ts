import { cancellationDeadline, shellSurvivesPrompt } from "./settlement.ts";
import type { Fact } from "@ace/core";
import { string, type Data } from "./data.ts";
import { TranslationState, type AgentState } from "./state.ts";
import { toolDetail } from "./tools.ts";
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
    if (detail.kind === "shell" && shellSurvivesPrompt(s.quirks.provider, reason)) {
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
          raw: [...tool.raw],
        });
      }
      if (!cancelled) continue;
      s.retainUncertainShell(tool);
      facts.push({ type: "background.ended", task: tool.task, status: "unknown", uncertain: true });
    }
    if (!cancelled && tool.child && !tool.child.terminal) continue;
    tool.status = "cancelled";
    s.liveTools.delete(tool);
    facts.push({
      type: "item.upsert",
      agent: tool.owner.key,
      item: tool.key,
      draft: {
        type: "tool_call",
        complete: true,
        call: { status: "cancelled", error: "turn ended without completion" },
      },
    });
  }
  if (cancelled)
    for (const child of s.agents.values())
      if (child !== s.root && !child.terminal) child.cancelAt = cancellationDeadline(now);
  if (cancelled && [...s.agents.values()].some((child) => child !== s.root && !child.terminal))
    facts.push({ type: "wake.expected", agent: agent.key, until: cancellationDeadline(now) });
  for (const [id, request] of s.requests)
    if (cancelled || request.owner === agent) {
      facts.push({ type: "interaction.closed", interaction: request.key, state: "cancelled" });
      s.requests.delete(id);
    }
  const classified =
    s.quirks.classifyError(agent.segment) ??
    (reason === "refusal"
      ? { kind: "quota" as const, message: "Provider refused the prompt" }
      : undefined) ??
    (Object.keys(error).length
      ? {
          kind: error["code"] === -32000 ? ("auth" as const) : ("provider" as const),
          message: string(error["message"]) || "ACP prompt failed",
        }
      : undefined);
  s.end(agent, facts, cancelled ? "interrupted" : classified ? "failed" : "completed", classified);
}
