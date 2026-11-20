import type { Fact } from "@ace/core";
import { holdsNextPrompt } from "./shell-settlement.ts";
import type { ToolState, TranslationState } from "./state.ts";
import { string } from "./data.ts";
import { toolDetail } from "./tools.ts";

/**
 * Reports a root tool that runs while no prompt is open as work holding the next prompt, for as
 * long as it runs: the session takes no new prompt meanwhile (`ShellSettlement.busy`, by the same
 * rule), so it is a task that blocks prompts and that the provider can't be asked to stop. A Stop
 * then knows to end it if it doesn't end by itself (ADR 0052).
 */
export function syncPromptHold(
  s: TranslationState,
  tool: ToolState,
  live: boolean,
  facts: Fact[],
): void {
  if (live && !tool.holdTask && holdsNextPrompt(s.promptOpen, tool.owner === s.root, !!tool.task)) {
    tool.holdTask = s.key("hold");
    facts.push({
      type: "background.started",
      agent: tool.owner.key,
      task: tool.holdTask,
      kind: toolDetail(tool.data, s.quirks).kind === "shell" ? "shell" : "other",
      title: string(tool.data["title"]) || "Tool",
      item: tool.key,
      stoppable: false,
      blocksPrompts: true,
    });
  } else if (!live && tool.holdTask) {
    facts.push({
      type: "background.ended",
      task: tool.holdTask,
      status:
        tool.status === "succeeded"
          ? "completed"
          : tool.status === "cancelled" || tool.status === "declined"
            ? "stopped"
            : "failed",
    });
    delete tool.holdTask;
  }
}
