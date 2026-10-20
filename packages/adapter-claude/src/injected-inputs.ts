import type { Key } from "@ace/core";
import type { ClaudeState } from "./state.ts";
import { object, string, type Data } from "./native.ts";

export type InjectedKind = "background_completion" | "subagent_result" | "parent_agent";

const notification = /^<task-notification>[\s\S]*<\/task-notification>$/;
const agentMessage = /^<agent-message from="[^"\n]*">[\s\S]*<\/agent-message>$/;

/**
 * What a user message Claude Code wrote for the model reports, or undefined for any other
 * text: a finished background task's `<task-notification>` (a subagent's when its task is a
 * `local_agent`), or another agent's `<agent-message>`. Pure.
 */
export function injectedInput(
  state: ClaudeState,
  data: Data,
  text: string,
): InjectedKind | undefined {
  const trimmed = text.trim();
  if (object(data["origin"])["kind"] === "task-notification" || notification.test(trimmed)) {
    const id = /<task-id>([^<\n]+)<\/task-id>/.exec(trimmed)?.[1]?.trim();
    const task = id ? state.tasks.get(id) : undefined;
    if (task)
      return task.data["task_type"] === "local_agent" ? "subagent_result" : "background_completion";
    // A task Claude started before this process saw it: the summary still names its kind.
    return /<summary>Agent\b/.test(trimmed) ? "subagent_result" : "background_completion";
  }
  return agentMessage.test(trimmed) ? "parent_agent" : undefined;
}

/** The subagent's own task prompt, which Claude echoes back as its first user message. */
export function childPrompt(state: ClaudeState, agent: Key, text: string): boolean {
  for (const task of state.tasks.values())
    if (task.child === agent && string(task.data["prompt"]) === text) return true;
  return false;
}
