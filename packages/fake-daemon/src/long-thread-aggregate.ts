import { digestFromCounters } from "@ace/projection";
import type { DigestContribution } from "@ace/projection";
import type { TurnDigest } from "@ace/protocol";

interface FileTotal {
  path: string;
  count: number;
  added: number;
  removed: number;
  unknownAdded: number;
  unknownRemoved: number;
}
interface CommandTotal {
  itemId: string;
  seq: number;
  value: TurnDigest["commands"][number] | null;
}
/** Signed intermediate values are clamped only when returning a public digest. */
export interface Aggregate {
  counters: Record<string, number>;
  files: FileTotal[];
  commands: CommandTotal[];
  truncated: boolean;
  firstUser?: { seq: number; preview: string };
  latestAssistant?: { seq: number; preview: string };
}
export const emptyAggregate = (): Aggregate => ({
  counters: {},
  files: [],
  commands: [],
  truncated: false,
});

export function contributionAggregate(
  value: DigestContribution | undefined,
  seq: number,
  sign = 1,
): Aggregate {
  if (!value) return emptyAggregate();
  return {
    counters: Object.fromEntries(
      Object.entries(value.counters).map(([key, count]) => [key, count * sign]),
    ),
    files: value.files.map((file) => ({
      path: file.path,
      count: sign,
      added: (file.added ?? 0) * sign,
      removed: (file.removed ?? 0) * sign,
      unknownAdded: Number(file.added === null) * sign,
      unknownRemoved: Number(file.removed === null) * sign,
    })),
    commands: value.commands.map((command) => ({
      itemId: command.itemId,
      seq,
      value: sign < 0 ? null : command,
    })),
    truncated: false,
  };
}

/** Fixed key ordering keeps bounded detail selection independent of tree rotations. */
export function combineAggregates(...values: Aggregate[]): Aggregate {
  const result = emptyAggregate();
  const files = new Map<string, FileTotal>();
  const commands = new Map<string, CommandTotal>();
  for (const value of values) {
    if (value.firstUser && (!result.firstUser || value.firstUser.seq < result.firstUser.seq))
      result.firstUser = value.firstUser;
    if (
      value.latestAssistant &&
      (!result.latestAssistant || value.latestAssistant.seq > result.latestAssistant.seq)
    )
      result.latestAssistant = value.latestAssistant;
    for (const [key, count] of Object.entries(value.counters))
      result.counters[key] = (result.counters[key] ?? 0) + count;
    for (const file of value.files) {
      const previous = files.get(file.path);
      if (!previous) files.set(file.path, { ...file });
      else
        for (const key of ["count", "added", "removed", "unknownAdded", "unknownRemoved"] as const)
          previous[key] += file[key];
    }
    for (const command of value.commands) {
      const previous = commands.get(command.itemId);
      if (!previous || previous.seq <= command.seq) commands.set(command.itemId, command);
    }
    result.truncated ||= value.truncated;
  }
  result.files = [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path)).slice(0, 64);
  result.commands = [...commands.values()]
    .toSorted((a, b) => a.itemId.localeCompare(b.itemId))
    .slice(0, 64);
  result.truncated ||= files.size > 64 || commands.size > 64;
  return result;
}

export function aggregateDigest(value: Aggregate): TurnDigest {
  const result = digestFromCounters(value.counters);
  result.files = value.files
    .filter((file) => file.count > 0 || file.added > 0 || file.removed > 0)
    .map((file) => ({
      path: file.path,
      added: file.unknownAdded > 0 ? null : Math.max(0, file.added),
      removed: file.unknownRemoved > 0 ? null : Math.max(0, file.removed),
    }));
  result.commands = value.commands.flatMap((command) => (command.value ? [command.value] : []));
  result.truncated = value.truncated;
  if (value.counters.tokenSamples !== undefined) {
    result.inputTokens = Math.max(0, value.counters.inputTokens ?? 0);
    result.outputTokens = Math.max(0, value.counters.outputTokens ?? 0);
  }
  return result;
}

type Key = readonly [number, number];
interface Node {
  key: Key;
  value: Aggregate;
  total: Aggregate;
  height: number;
  left?: Node | undefined;
  right?: Node | undefined;
}
const height = (node: Node | undefined) => node?.height ?? 0;
const compare = (a: Key, b: Key) => a[0] - b[0] || a[1] - b[1];
function refresh(node: Node): Node {
  node.height = 1 + Math.max(height(node.left), height(node.right));
  node.total = combineAggregates(
    node.left?.total ?? emptyAggregate(),
    node.value,
    node.right?.total ?? emptyAggregate(),
  );
  return node;
}
function rotateLeft(node: Node): Node {
  const next = node.right;
  if (!next) return node;
  node.right = next.left;
  next.left = refresh(node);
  return refresh(next);
}
function rotateRight(node: Node): Node {
  const next = node.left;
  if (!next) return node;
  node.left = next.right;
  next.right = refresh(node);
  return refresh(next);
}
function insert(node: Node | undefined, key: Key, value: Aggregate): Node {
  if (!node) return { key, value, total: value, height: 1 };
  const order = compare(key, node.key);
  if (order < 0) node.left = insert(node.left, key, value);
  else if (order > 0) node.right = insert(node.right, key, value);
  else node.value = value;
  refresh(node);
  if (height(node.left) - height(node.right) > 1) {
    if (node.left && compare(key, node.left.key) > 0) node.left = rotateLeft(node.left);
    return rotateRight(node);
  }
  if (height(node.right) - height(node.left) > 1) {
    if (node.right && compare(key, node.right.key) < 0) node.right = rotateRight(node.right);
    return rotateLeft(node);
  }
  return node;
}
function suffix(node: Node | undefined, after: number): Aggregate {
  if (!node) return emptyAggregate();
  if (node.key[0] <= after) return suffix(node.right, after);
  return combineAggregates(
    suffix(node.left, after),
    node.value,
    node.right?.total ?? emptyAggregate(),
  );
}

/** A pure ordered aggregate tree. Updates and suffix reads visit O(log changes) nodes. */
export class AggregateIndex {
  private root: Node | undefined;
  set(key: number, tie: number, value: Aggregate): void {
    this.root = insert(this.root, [key, tie], value);
  }
  all(): Aggregate {
    return this.root?.total ?? emptyAggregate();
  }
  after(key: number): Aggregate {
    return suffix(this.root, key);
  }
}

/** Sequence and timestamp ordering are separate; backdated appends preserve time semantics. */
export class ChangeIndex {
  private sequence = new AggregateIndex();
  private time = new AggregateIndex();
  append(seq: number, at: number, value: Aggregate): void {
    this.sequence.set(seq, 0, value);
    this.time.set(at, seq, value);
  }
  range(since: { sinceSeq?: number | undefined; sinceTime?: number | undefined }): Aggregate {
    return since.sinceSeq !== undefined
      ? this.sequence.after(since.sinceSeq)
      : this.time.after(since.sinceTime ?? 0);
  }
}
