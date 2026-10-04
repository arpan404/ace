import type { Item, FileChange, Interaction, ThreadStatus, TurnDigest } from "@ace/protocol";

export interface DigestContribution {
  counters: Record<string, number>;
  files: TurnDigest["files"];
  commands: TurnDigest["commands"];
}

export function emptyTurnDigest(): TurnDigest {
  return {
    toolCounts: {},
    files: [],
    commands: [],
    commandsRun: 0,
    commandsFailed: 0,
    approvalsAsked: 0,
    approvalsAnswered: 0,
    approvalsAutoReviewed: 0,
    approvalsPending: 0,
    subagentsStarted: 0,
    subagentsFinished: 0,
    inputTokens: null,
    outputTokens: null,
    errors: 0,
    truncated: false,
  };
}

export function itemMessagePreview(item: Item): string {
  if (item.type !== "message") return "";
  let result = "";
  for (const part of item.parts) {
    if (part.type === "text") result += part.text.slice(0, 1024 - result.length);
    if (result.length === 1024) break;
  }
  return result;
}

const lines = (text: string) =>
  text.length ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

function changedLines(change: FileChange): { added: number | null; removed: number | null } {
  if (change.diff !== undefined) {
    let added = 0,
      removed = 0,
      inHunk = false;
    for (const match of change.diff.matchAll(/(?:^|\n)([^\n]*)/g)) {
      const line = match[1] ?? "";
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      if (line.startsWith("diff --git ")) {
        inHunk = false;
        continue;
      }
      if (!inHunk && (line.startsWith("+++ ") || line.startsWith("--- "))) continue;
      if (line.startsWith("+")) added++;
      if (line.startsWith("-")) removed++;
    }
    return { added, removed };
  }
  // Without a diff, only additions/deletions have exact line information.
  if (change.kind === "add" && change.newText !== undefined)
    return { added: lines(change.newText), removed: 0 };
  if (change.kind === "delete" && typeof change.oldText === "string")
    return { added: 0, removed: lines(change.oldText) };
  return { added: null, removed: null };
}

/** Authoritative replacements contribute differences, never another copy of a tool. */
export function itemDigestContribution(item: Item): DigestContribution {
  const result: DigestContribution = { counters: {}, files: [], commands: [] };
  if (item.type === "notice" && item.level === "error") result.counters.errors = 1;
  if (item.type !== "tool_call") return result;
  const call = item.call;
  result.counters[`tool:${call.kind}`] = 1;
  result.counters["live:tools"] = Number(
    call.status === "pending" || call.status === "awaiting_approval" || call.status === "running",
  );
  if (call.error || call.status === "failed") result.counters.errors = 1;
  if (call.detail.kind === "shell") {
    const failed =
      call.status === "failed" || (call.detail.exitCode != null && call.detail.exitCode !== 0);
    const ran =
      call.status === "running" ||
      call.status === "succeeded" ||
      call.status === "failed" ||
      call.detail.exitCode != null;
    result.counters.commandsRun = Number(ran);
    result.counters.commandsFailed = Number(failed);
    if (failed) result.counters.errors = 1;
    if (ran)
      result.commands.push({
        itemId: item.id,
        command: call.detail.command.slice(0, 1024),
        failed,
        ...(call.detail.exitCode === undefined ? {} : { exitCode: call.detail.exitCode }),
      });
  }
  if ("changes" in call.detail && call.status === "succeeded")
    for (const change of call.detail.changes)
      result.files.push({
        path: (change.movePath ?? change.path).slice(0, 4096),
        ...changedLines(change),
      });
  return result;
}

export function agentThreadStatus(status: import("@ace/protocol").AgentStatus): ThreadStatus {
  if (status.state === "idle" || status.state === "interrupted") return { state: "done" };
  if (status.state === "failed" || status.state === "unresponsive") return { state: status.state };
  if (status.state === "blocked") {
    if (status.on === "human") return { state: "needs_you", interactions: 1 };
    if (status.on === "subagents") return { state: "working", agents: 1 };
    if (status.on === "rate_limit")
      return { state: "limited", ...(status.until === undefined ? {} : { until: status.until }) };
    return { state: "waiting", on: status.on };
  }
  return { state: "working", agents: 1 };
}

/** Historical turns combine their own live activity, rather than a later root turn's status. */
export function turnActivityStatus(
  counters: Readonly<Record<string, number>>,
  candidates: readonly ThreadStatus[],
): ThreadStatus | undefined {
  const interactions = Math.max(
    counters["live:interactions"] ?? 0,
    ...candidates.map((status) => (status.state === "needs_you" ? status.interactions : 0)),
  );
  if (interactions > 0) return { state: "needs_you", interactions };
  if (candidates.some((s) => s.state === "working"))
    return { state: "working", agents: Math.max(1, counters["live:agents"] ?? 0) };
  const limited = candidates.find((s) => s.state === "limited");
  if (limited) return limited;
  for (const reason of ["network", "upstream"] as const)
    if (candidates.some((s) => s.state === "waiting" && s.on === reason))
      return { state: "waiting", on: reason };
  if (
    (counters["live:tasks"] ?? 0) > 0 ||
    (counters["live:tools"] ?? 0) > 0 ||
    candidates.some((s) => s.state === "waiting" && s.on === "background_task")
  )
    return { state: "waiting", on: "background_task" };
  if (candidates.some((s) => s.state === "unresponsive")) return { state: "unresponsive" };
  const waiting = candidates.find((s) => s.state === "waiting");
  if (waiting) return waiting;
  if ((counters["live:agents"] ?? 0) > 0 || (counters["live:runs"] ?? 0) > 0)
    return { state: "working", agents: Math.max(1, counters["live:agents"] ?? 0) };
  return undefined;
}

export function turnIsSettled(status: ThreadStatus): boolean {
  return status.state === "done" || status.state === "failed" || status.state === "new";
}

export function approvalAutoReviewed(
  approval: Pick<Interaction, "autoReviewed" | "review">,
): boolean {
  return approval.autoReviewed === true || approval.review?.mode === "auto-review";
}
