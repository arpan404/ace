import { ToolKind, type TurnDigest } from "@ace/protocol";
import { emptyTurnDigest, type DigestContribution } from "./long-thread.ts";

const counterKeys = [
  "commandsRun",
  "commandsFailed",
  "approvalsAsked",
  "approvalsAnswered",
  "approvalsAutoReviewed",
  "approvalsPending",
  "subagentsStarted",
  "subagentsFinished",
  "errors",
] as const;

/** Decode persisted counters without coupling the digest to a storage representation. */
export function digestFromCounters(counters: Readonly<Record<string, number>>): TurnDigest {
  const result = emptyTurnDigest();
  for (const key of counterKeys) result[key] = Math.max(0, counters[key] ?? 0);
  for (const [key, value] of Object.entries(counters)) {
    if (!key.startsWith("tool:")) continue;
    const kind = ToolKind.safeParse(key.slice(5));
    if (kind.success) result.toolCounts[kind.data] = Math.max(0, value);
  }
  result.inputTokens = counters.inputTokens ?? null;
  result.outputTokens = counters.outputTokens ?? null;
  return result;
}

/** Combine bounded summaries. Counts remain exact when detail arrays are truncated. */
export function mergeTurnDigests(digests: Iterable<TurnDigest>): TurnDigest {
  const result = emptyTurnDigest();
  const files = new Map<string, TurnDigest["files"][number]>();
  const commands = new Map<string, TurnDigest["commands"][number]>();
  for (const digest of digests) {
    for (const key of counterKeys) result[key] += digest[key];
    for (const [key, value] of Object.entries(digest.toolCounts)) {
      const kind = ToolKind.safeParse(key);
      if (kind.success && value !== undefined)
        result.toolCounts[kind.data] = (result.toolCounts[kind.data] ?? 0) + value;
    }
    if (digest.inputTokens !== null)
      result.inputTokens = (result.inputTokens ?? 0) + digest.inputTokens;
    if (digest.outputTokens !== null)
      result.outputTokens = (result.outputTokens ?? 0) + digest.outputTokens;
    for (const file of digest.files) {
      const previous = files.get(file.path);
      if (previous) {
        previous.added =
          previous.added === null || file.added === null ? null : previous.added + file.added;
        previous.removed =
          previous.removed === null || file.removed === null
            ? null
            : previous.removed + file.removed;
      } else if (files.size < 64) files.set(file.path, { ...file });
      else result.truncated = true;
    }
    for (const command of digest.commands) {
      if (commands.has(command.itemId) || commands.size < 64)
        commands.set(command.itemId, { ...command });
      else result.truncated = true;
    }
    result.truncated ||= digest.truncated;
  }
  result.commands = [...commands.values()];
  result.files = [...files.values()].toSorted((left, right) => left.path.localeCompare(right.path));
  return result;
}

/** Summarize current authoritative item contributions without counting replaced tool calls twice. */
export function digestContributions(contributions: Iterable<DigestContribution>): TurnDigest {
  function* digests(): Generator<TurnDigest> {
    for (const contribution of contributions) {
      const digest = digestFromCounters(contribution.counters);
      digest.files = contribution.files;
      digest.commands = contribution.commands;
      yield digest;
    }
  }
  return mergeTurnDigests(digests());
}
