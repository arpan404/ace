import type { ThreadReader } from "@ace/client";
import type { Agent, Item, ProviderKind } from "@ace/protocol";

export interface LogLine {
  /** Stable across re-derivations, for React keys. */
  key: string;
  at: number;
  source: "session" | "agent" | "turn" | "shell" | "task" | "input" | "notice";
  level: "info" | "warn" | "error";
  text: string;
}

const name = (agent: Agent | undefined, root: string | undefined) =>
  !agent ? "agent" : agent.id === root ? "main agent" : (agent.name ?? agent.role ?? "subagent");
const provider = (kind: ProviderKind) => (kind === "claude" ? "claude-code" : kind);

/**
 * The thread's operational log, derived from the live store: sessions and subagents starting
 * and ending, turns, background work, questions and provider notices. Sorted by time. Pure.
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
  for (const id of reader.agentIds()) {
    const agent = reader.agent(id);
    if (!agent) continue;
    const who = name(agent, root);
    push({
      key: `agent:${id}`,
      at: agent.createdAt,
      source: agent.id === root ? "session" : "agent",
      level: "info",
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
        text: `${who} failed: ${agent.status.error.message}`,
      });
    else if (agent.endedAt !== undefined)
      push({
        key: `agent-ended:${id}`,
        at: agent.endedAt,
        source: "agent",
        level: "info",
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
          text: `turn started (${run.trigger.replace("_", " ")})`,
        });
        if (run.endedAt !== undefined)
          push({
            key: `run-ended:${run.id}`,
            at: run.endedAt,
            source: "turn",
            level: run.state === "failed" ? "error" : "info",
            text: `turn ${run.state}`,
          });
      }
    }
    const notice = noticeOf(item);
    if (notice) push(notice);
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
      text: `started ${task.title} in background`,
    });
    if (task.status !== "running")
      push({
        key: `task-ended:${id}`,
        at: task.endedAt ?? task.startedAt,
        source,
        level: task.status === "failed" ? "error" : task.status === "unknown" ? "warn" : "info",
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
      text: `${title} · waiting for you`,
    });
    if (interaction.state !== "pending")
      push({
        key: `input-closed:${id}`,
        at: interaction.closedAt ?? interaction.createdAt,
        source: "input",
        level: "info",
        text: `${title} · ${interaction.state}`,
      });
  }
  return lines.toSorted((a, b) => a.at - b.at);
}

function noticeOf(item: Item): LogLine | undefined {
  if (item.type === "notice")
    return {
      key: `notice:${item.id}`,
      at: item.createdAt,
      source: "notice",
      level: item.level === "error" ? "error" : item.level === "warning" ? "warn" : "info",
      text: item.text,
    };
  if (item.type === "compaction")
    return {
      key: `notice:${item.id}`,
      at: item.createdAt,
      source: "notice",
      level: "info",
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
