import type { Agent, AgentStatus, Interaction, Item } from "@ace/protocol";
import { agentName, describeActivity } from "./agents.ts";
import { displayCommand } from "./step-display.ts";
import { resultLead } from "./system-events.ts";
import { mcpToolLabel } from "./tool-labels.ts";

/*
 * What an agent is for and what it is doing, in plain words for the Summary's rows: its task from
 * the call that started it, its current step from its latest live item ("editing work-side.tsx",
 * "running bun run typecheck"), and once it has finished, the first line of its result. Pure.
 */

const fileName = (path: string) => path.split(/[/\\]/).findLast(Boolean) ?? path;

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line ? clip(line, 120) : undefined;
}

/** "a.ts", "a.ts and b.ts", "a.ts and 2 more". */
function files(paths: readonly string[]): string {
  const names = [...new Set(paths.map(fileName))];
  if (names.length <= 2) return names.join(" and ");
  return `${names[0]} and ${names.length - 1} more`;
}

/**
 * The task an agent was given, in one line: the spawning call's description, else the first line
 * of its prompt, else the call's title; a delegated thread's title. Undefined when nothing says.
 */
export function agentTask(spawn: Item | undefined): string | undefined {
  if (spawn?.type === "delegation.started") return firstLine(spawn.title) ?? firstLine(spawn.role);
  if (spawn?.type !== "tool_call") return undefined;
  const detail = spawn.call.detail;
  if (detail.kind === "agent.spawn")
    return firstLine(detail.description) ?? firstLine(detail.prompt) ?? firstLine(spawn.call.title);
  return firstLine(spawn.call.title);
}

/**
 * The name an agent goes by: its own name or role, else its task, so an unnamed subagent reads
 * as what it was asked to do rather than "Subagent". The main agent is its provider.
 */
export function agentLabel(
  agent: Pick<Agent, "origin" | "native" | "name" | "role">,
  task: string | undefined,
): string {
  if (agent.origin === "root") return agentName(agent);
  return agent.name ?? agent.role ?? task ?? agentName(agent);
}

/** The first line of what a finished agent handed back, from its delegation or spawning call. */
export function agentResult(spawn: Item | undefined): string | undefined {
  const text =
    spawn?.type === "delegation.started"
      ? (spawn.outcome?.result ?? undefined)
      : spawn?.type === "tool_call"
        ? spawn.call.result?.content.find((part) => part.type === "text")?.text
        : undefined;
  const lead = text ? resultLead(text, 140) : "";
  return lead || undefined;
}

/** A tool call's step while it runs: "editing turn-index.ts", "running bun run typecheck". */
function toolStep(item: Extract<Item, { type: "tool_call" }>): string {
  const call = item.call;
  if (call.status === "awaiting_approval") return "waiting on approval";
  const detail = call.detail;
  switch (detail.kind) {
    case "shell":
      return `running ${clip(displayCommand(detail).command, 80)}`;
    case "file.read":
      return `reading ${fileName(detail.path)}`;
    case "file.edit":
    case "file.write":
      return detail.changes.length
        ? `${detail.changes.some((change) => change.kind !== "add") ? "editing" : "writing"} ${files(detail.changes.map((change) => change.path))}`
        : "editing files";
    case "file.delete":
      return `deleting ${files(detail.changes.map((change) => change.path))}`;
    case "file.move":
      return `moving ${files(detail.changes.map((change) => change.path))}`;
    case "search":
      return `searching for ${clip(detail.query, 60)}`;
    case "web.search":
      return `searching the web for ${clip(detail.query, 60)}`;
    case "web.fetch":
      return `reading ${clip(detail.url.replace(/^https?:\/\//, ""), 60)}`;
    case "mcp": {
      const label = mcpToolLabel(detail.server, detail.tool, detail.arguments);
      const running = label.running.charAt(0).toLowerCase() + label.running.slice(1);
      return label.target ? `${running} ${clip(label.target, 60)}` : running;
    }
    case "agent.spawn":
      return `starting a subagent${detail.description ? ` to ${clip(detail.description, 60)}` : ""}`;
    case "agent.message":
      return "messaging a subagent";
    case "todo":
    case "plan":
      return "updating its plan";
    case "ask_user":
      return "asking you";
    default:
      // A tool known only by name says what its own title says ("Pair a phone on …").
      return call.title ? clip(call.title, 80) : "using a tool";
  }
}

/** What waiting on the person means for the request it waits on. */
function waitingOn(interaction: Pick<Interaction, "request"> | undefined): string {
  switch (interaction?.request.kind) {
    case "approval":
      return "waiting on approval";
    case "question":
    case "elicitation":
      return "waiting on your answer";
    case "plan_review":
      return "waiting for you to review its plan";
    case "browser_help":
      return "waiting for you in the browser";
    default:
      return "waiting on you";
  }
}

/**
 * The agent's current step in plain words, from its status and its latest live item: the tool it
 * runs, "thinking", "writing its reply", or what it waits on. A failed agent says why, in one line.
 */
export function agentStep(input: {
  status: AgentStatus;
  /** The item its status points at (the running tool call), when loaded. */
  item?: Item | undefined;
  /** The request it waits on, when it waits on the person. */
  interaction?: Pick<Interaction, "request"> | undefined;
}): string {
  const { status, item } = input;
  if (status.state === "blocked" && status.on === "human") return waitingOn(input.interaction);
  if (status.state === "failed") return firstLine(status.error.message) ?? "failed";
  if (status.state === "working") {
    if (status.detail) return clip(status.detail, 80);
    if (item?.type === "tool_call") return toolStep(item);
    if (status.activity === "responding") return "writing its reply";
  }
  return describeActivity(status);
}
