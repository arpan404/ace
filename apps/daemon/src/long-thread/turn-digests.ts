import { TurnDigest } from "@ace/protocol";
import { digestFromCounters } from "@ace/projection";
import type { Counters, LongThreadDatabase } from "./database.ts";

// Index rows hold protocol values written by whichever build indexed them (the index has no
// build fingerprint), so the JSON commands and the paths are validated as they are read.
const Command = TurnDigest.shape.commands.element;
const Path = TurnDigest.shape.files.element.shape.path;

/** A whole turn's digest key: a thread and a turn ordinal (0 is the whole thread). */
export type TurnKey = readonly [thread: string, ordinal: number];
/** A digest key for one agent's share of a turn in the page's thread. */
export type AgentKey = readonly [ordinal: number, agent: string];

// Each statement reads every key of a page at once. A key's rows come from its own indexed
// lookup with the same order and limit a single-key read uses (64 shown, one more says there
// are more), so a busy turn never makes the others read more. `CROSS JOIN` keeps the key list
// the outer loop, so each lookup uses the table's primary key or recent index.
const turnCounts =
  "SELECT j.key AS k, c.key, c.value FROM json_each(?) j CROSS JOIN long_counts c ON c.thread_id=json_extract(j.value,'$[0]') AND c.ordinal=json_extract(j.value,'$[1]')";
const turnFiles =
  "SELECT j.key AS k, f.added, f.removed, f.unknown, f.path FROM json_each(?) j CROSS JOIN long_files f WHERE f.rowid IN (SELECT rowid FROM long_files WHERE thread_id=json_extract(j.value,'$[0]') AND ordinal=json_extract(j.value,'$[1]') AND last_seq>-1 ORDER BY last_seq,path LIMIT 65) ORDER BY j.key, f.last_seq, f.path";
const turnCommands =
  "SELECT j.key AS k, c.data FROM json_each(?) j CROSS JOIN long_commands c WHERE c.rowid IN (SELECT rowid FROM long_commands WHERE thread_id=json_extract(j.value,'$[0]') AND ordinal=json_extract(j.value,'$[1]') AND last_seq>-1 ORDER BY last_seq,item_id LIMIT 65) ORDER BY j.key, c.last_seq, c.item_id";
const agentCounts =
  "SELECT j.key AS k, c.key, c.value FROM json_each(?) j CROSS JOIN long_agent_counts c ON c.thread_id=? AND c.ordinal=json_extract(j.value,'$[0]') AND c.agent_id=json_extract(j.value,'$[1]')";
const agentFiles =
  "SELECT j.key AS k, f.added, f.removed, f.unknown, f.path FROM json_each(?) j CROSS JOIN long_agent_files f WHERE f.rowid IN (SELECT rowid FROM long_agent_files WHERE thread_id=? AND ordinal=json_extract(j.value,'$[0]') AND agent_id=json_extract(j.value,'$[1]') ORDER BY path LIMIT 65) ORDER BY j.key, f.path";
const agentCommands =
  "SELECT j.key AS k, c.data FROM json_each(?) j CROSS JOIN long_commands c WHERE c.rowid IN (SELECT c2.rowid FROM long_commands c2 JOIN long_items i ON i.thread_id=c2.thread_id AND i.item_id=c2.item_id WHERE c2.thread_id=? AND c2.ordinal=json_extract(j.value,'$[0]') AND i.agent_id=json_extract(j.value,'$[1]') ORDER BY c2.item_id LIMIT 65) ORDER BY j.key, c.item_id";

/** Rows of one statement grouped by the index of the key they belong to. */
function grouped(
  rows: Iterable<Record<string, unknown>>,
  count: number,
): Record<string, unknown>[][] {
  const groups = Array.from({ length: count }, (): Record<string, unknown>[] => []);
  for (const row of rows) groups[Number(row.k)]?.push(row);
  return groups;
}
function counters(rows: readonly Record<string, unknown>[]): Counters {
  return Object.fromEntries(rows.map((row) => [String(row.key), Number(row.value)]));
}
type FileEntry = TurnDigest["files"][number];
/** A `long_files` row: line counts are unknown once any change to the path had none. */
const turnFile = (row: Record<string, unknown>): FileEntry => {
  const unknown = Number(row.unknown) > 0;
  return {
    path: Path.parse(row.path),
    added: unknown ? null : Math.max(0, Number(row.added)),
    removed: unknown ? null : Math.max(0, Number(row.removed)),
  };
};
/** A `long_agent_files` row, read as an agent's share always was. */
const agentFile = (row: Record<string, unknown>): FileEntry => {
  const unknown = Number(row.unknown) !== 0;
  return {
    path: Path.parse(row.path),
    added: unknown ? null : Number(row.added),
    removed: unknown ? null : Number(row.removed),
  };
};
/** The digest's bounded details: at most 64 files and commands, truncated if there were more. */
function details(
  digest: TurnDigest,
  files: readonly Record<string, unknown>[],
  file: (row: Record<string, unknown>) => FileEntry,
  commands: readonly Record<string, unknown>[],
): TurnDigest {
  digest.files = files.slice(0, 64).map(file);
  digest.commands = commands.slice(0, 64).map((row) => Command.parse(JSON.parse(String(row.data))));
  digest.truncated = files.length > 64 || commands.length > 64;
  return digest;
}

/** The whole-turn digests of `keys`, in order, with the counters each was built from. */
export function readTurnDigests(
  data: LongThreadDatabase,
  keys: readonly TurnKey[],
): { digest: TurnDigest; counters: Counters }[] {
  if (!keys.length) return [];
  const list = JSON.stringify(keys);
  const counts = grouped(data.sql(turnCounts).iterate(list), keys.length);
  const files = grouped(data.sql(turnFiles).iterate(list), keys.length);
  const commands = grouped(data.sql(turnCommands).iterate(list), keys.length);
  return keys.map((_, index) => {
    const current = counters(counts[index] ?? []);
    const digest = digestFromCounters(current);
    digest.approvalsPending = current.approvalsPending ?? 0;
    digest.inputTokens = current.tokenSamples ? Math.max(0, current.inputTokens ?? 0) : null;
    digest.outputTokens = current.tokenSamples ? Math.max(0, current.outputTokens ?? 0) : null;
    return {
      digest: details(digest, files[index] ?? [], turnFile, commands[index] ?? []),
      counters: current,
    };
  });
}

/** Each agent's own share of its turn in `thread`, in the order of `keys`. */
export function readAgentDigests(
  data: LongThreadDatabase,
  thread: string,
  keys: readonly AgentKey[],
): TurnDigest[] {
  if (!keys.length) return [];
  const list = JSON.stringify(keys);
  const counts = grouped(data.sql(agentCounts).iterate(list, thread), keys.length);
  const files = grouped(data.sql(agentFiles).iterate(list, thread), keys.length);
  const commands = grouped(data.sql(agentCommands).iterate(list, thread), keys.length);
  return keys.map((_, index) =>
    details(
      digestFromCounters(counters(counts[index] ?? [])),
      files[index] ?? [],
      agentFile,
      commands[index] ?? [],
    ),
  );
}
