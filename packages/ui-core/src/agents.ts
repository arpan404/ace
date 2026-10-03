import type { Agent, AgentStatus, BackgroundTask } from "@ace/protocol";

/** What an agent is doing, in the quiet lower-case phrasing of the tree ("waiting for subagents"). */
export function describeActivity(status: AgentStatus, toolTitle?: string): string {
  switch (status.state) {
    case "starting":
      return "starting";
    case "working":
      if (status.detail) return status.detail;
      if (status.activity === "tool") return toolTitle ?? "running a tool";
      return {
        thinking: "thinking",
        responding: "writing",
        compacting: "compacting its context",
        retrying: "retrying",
        starting_turn: "starting a turn",
      }[status.activity];
    case "blocked":
      return {
        human: "needs you",
        subagents: "waiting for subagents",
        background_task: "waiting on a background task",
        rate_limit: "rate limited",
        network: "waiting for the network",
        upstream: "provider is retrying",
      }[status.on];
    case "idle":
      return "done";
    case "interrupted":
      return "stopped";
    case "failed":
      return status.error.message;
    case "unresponsive":
      return "not responding";
  }
}

export type AgentGlyph = "spinner" | "waiting" | "needs-you" | "failed" | "done" | "stopped";
export function glyphOf(status: AgentStatus): AgentGlyph {
  switch (status.state) {
    case "starting":
    case "working":
      return "spinner";
    case "blocked":
      return status.on === "human" ? "needs-you" : "waiting";
    case "failed":
    case "unresponsive":
      return "failed";
    case "idle":
      return "done";
    case "interrupted":
      return "stopped";
  }
}

export const isRunning = (agent: Pick<Agent, "status">) =>
  agent.status.state === "working" ||
  agent.status.state === "starting" ||
  agent.status.state === "blocked";

const taskStates: Record<BackgroundTask["status"], string> = {
  running: "running",
  completed: "finished",
  failed: "failed",
  stopped: "stopped",
  unknown: "possibly running",
};
export const taskState = (task: BackgroundTask) => taskStates[task.status];
