import type { ThreadReader } from "@ace/client";
import type { Agent, Item, ProviderKind } from "@ace/protocol";

export interface LogLine {
  /** Stable across re-derivations, for React keys. */
  key: string;
  at: number;
  source: "daemon" | "session" | "agent" | "turn" | "shell" | "task" | "input" | "notice";
  level: "info" | "warn" | "error";
  text: string;
  /** The agent the line is about, for an agent's log; absent for the thread's own lines. */
  agentId?: string | undefined;
}

export type LogSource = LogLine["source"];
export type LogLevel = LogLine["level"];

const name = (agent: Agent | undefined, root: string | undefined) =>
  !agent ? "agent" : agent.id === root ? "main agent" : (agent.name ?? agent.role ?? "subagent");
const provider = (kind: ProviderKind) => (kind === "claude" ? "claude-code" : kind);

/**
 * The thread's operational log, derived from the live store: the thread's creation, sessions
 * and subagents starting and ending, turns, shell commands and their exit codes, background
 * work, questions and provider notices (rate-limit and quota warnings among them). Sorted by
 * time. Pure.
 */
export function threadLog(
  reader: Pick<
    ThreadReader,
    | "thread"
    | "order"
    | "item"
    | "run"
    | "agent"
    | "agentIds"
    | "taskIds"
    | "task"
    | "interactionIds"
    | "interaction"
  >,
): LogLine[] {
  const root = reader.thread?.rootAgentId;
  const lines: LogLine[] = [];
  const push = (line: LogLine) => lines.push(line);
  const thread = reader.thread;
  if (thread)
    push({
      key: `thread:${thread.id}`,
      at: thread.createdAt,
      source: "daemon",
      level: "info",
      text: `thread created in ${thread.workspaceId}`,
    });
  for (const id of reader.agentIds()) {
    const agent = reader.agent(id);
    if (!agent) continue;
    const who = name(agent, root);
    push({
      key: `agent:${id}`,
      at: agent.createdAt,
      source: agent.id === root ? "session" : "agent",
      level: "info",
      agentId: id,
      text:
        agent.id === root
          ? `${provider(agent.native.provider)} session started in ${agent.cwd}`
          : `subagent ${who} spawned · ${provider(agent.native.provider)}${agent.model ? ` · ${agent.model}` : ""}`,
    });
    if (agent.status.state === "failed")
      push({
        key: `agent-failed:${id}`,
        at: agent.endedAt ?? agent.createdAt,
        source: "agent",
        level: "error",
        agentId: id,
        text: `${who} failed: ${agent.status.error.message}`,
      });
    else if (agent.endedAt !== undefined)
      push({
        key: `agent-ended:${id}`,
        at: agent.endedAt,
        source: "agent",
        level: "info",
        agentId: id,
        text: `${who} finished`,
      });
  }
  const runs = new Set<string>();
  for (const id of reader.order) {
    const item = reader.item(id);
    if (!item) continue;
    if (item.runId && !runs.has(item.runId)) {
      runs.add(item.runId);
      const run = reader.run(item.runId);
      if (run && run.agentId === root) {
        push({
          key: `run:${run.id}`,
          at: run.startedAt,
          source: "turn",
          level: "info",
          agentId: run.agentId,
          text: `turn started (${run.trigger.replace("_", " ")})`,
        });
        if (run.endedAt !== undefined)
          push({
            key: `run-ended:${run.id}`,
            at: run.endedAt,
            source: "turn",
            level: run.state === "failed" ? "error" : "info",
            agentId: run.agentId,
            text: `turn ${run.state}`,
          });
      }
    }
    const notice = noticeOf(item);
    if (notice) push(notice);
    for (const line of shellLines(item, (agentId) => reader.agent(agentId), root)) push(line);
  }
  for (const id of reader.taskIds()) {
    const task = reader.task(id);
    if (!task) continue;
    const source = task.kind === "shell" ? "shell" : "task";
    push({
      key: `task:${id}`,
      at: task.startedAt,
      source,
      level: "info",
      agentId: task.agentId,
      text: `started ${task.title} in background`,
    });
    if (task.status !== "running")
      push({
        key: `task-ended:${id}`,
        at: task.endedAt ?? task.startedAt,
        source,
        level: task.status === "failed" ? "error" : task.status === "unknown" ? "warn" : "info",
        agentId: task.agentId,
        text: `${task.title} ${task.status === "unknown" ? "lost track (may still be running)" : task.status}`,
      });
  }
  for (const id of reader.interactionIds()) {
    const interaction = reader.interaction(id);
    if (!interaction) continue;
    const title =
      interaction.request.kind === "approval" ? interaction.request.title : "question for you";
    push({
      key: `input:${id}`,
      at: interaction.createdAt,
      source: "input",
      level: "warn",
      agentId: interaction.agentId,
      text: `${title} · waiting for you`,
    });
    if (interaction.state !== "pending")
      push({
        key: `input-closed:${id}`,
        at: interaction.closedAt ?? interaction.createdAt,
        source: "input",
        level: "info",
        agentId: interaction.agentId,
        text: `${title} · ${interaction.state}`,
      });
  }
  return lines.toSorted((a, b) => a.at - b.at);
}

/** A foreground shell command: when it ran, who ran it, and how it exited. */
function shellLines(
  item: Item,
  agentOf: (id: string) => Agent | undefined,
  root: string | undefined,
): LogLine[] {
  if (item.type !== "tool_call" || item.call.detail.kind !== "shell" || item.call.backgroundTaskId)
    return [];
  const { call } = item;
  const agent = agentOf(call.agentId);
  const command = call.detail.kind === "shell" ? call.detail.command : call.title;
  const exit = call.detail.kind === "shell" ? call.detail.exitCode : undefined;
  const who = agent && agent.id !== root ? ` (${name(agent, root)})` : "";
  const lines: LogLine[] = [
    {
      key: `shell:${item.id}`,
      at: call.startedAt,
      source: "shell",
      level: "info",
      agentId: call.agentId,
      text: `$ ${command}${who}`,
    },
  ];
  if (call.status === "failed" || call.status === "succeeded")
    lines.push({
      key: `shell-ended:${item.id}`,
      at: call.endedAt ?? call.startedAt,
      source: "shell",
      level: call.status === "failed" ? "error" : "info",
      agentId: call.agentId,
      text: `${command} · ${exit !== undefined && exit !== null ? `exit ${exit}` : call.status}`,
    });
  return lines;
}

function noticeOf(item: Item): LogLine | undefined {
  if (item.type === "notice")
    return {
      key: `notice:${item.id}`,
      at: item.createdAt,
      source: "notice",
      level: item.level === "error" ? "error" : item.level === "warning" ? "warn" : "info",
      agentId: item.agentId,
      text: item.text,
    };
  if (item.type === "compaction")
    return {
      key: `notice:${item.id}`,
      at: item.createdAt,
      source: "notice",
      level: "info",
      agentId: item.agentId,
      text: "context compacted",
    };
  return undefined;
}

export function logEqual(a: readonly LogLine[], b: readonly LogLine[]): boolean {
  return (
    a.length === b.length &&
    a.every((line, i) => {
      const other = b[i];
      return (
        other?.key === line.key &&
        other.at === line.at &&
        other.text === line.text &&
        other.level === line.level
      );
    })
  );
}
