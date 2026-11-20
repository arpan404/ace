/*
 * Folder paths inside a provider's session files, moved to the checkout a transfer landed in
 * (ADR 0191). Pure. Decoding is lenient: a line that isn't JSON, or a record whose shape isn't
 * known, is kept byte for byte. Only a path equal to the source folder or inside it changes.
 */

/** `path` moved from inside `from` to the same place inside `to`; none when it isn't inside. */
export function movedPath(path: string, from: string, to: string): string | undefined {
  const base = from.replace(/[\\/]+$/, "");
  if (!base) return undefined;
  if (path === base) return to;
  const next = path.charAt(base.length);
  if (!path.startsWith(base) || (next !== "/" && next !== "\\")) return undefined;
  return to.replace(/[\\/]+$/, "") + path.slice(base.length);
}

type Record = { [key: string]: unknown };
const isRecord = (value: unknown): value is Record =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The object in one decoded record that holds its `cwd`, if the record has one. */
export type CwdHolder = (record: Record) => Record | undefined;

/** Rewrites one line; unchanged unless it is a JSON record whose `cwd` lies inside `from`. */
export function rewriteLine(line: string, from: string, to: string, holder: CwdHolder): string {
  if (!line.trim()) return line;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isRecord(record)) return line;
  const owner = holder(record);
  const cwd = owner?.cwd;
  if (!owner || typeof cwd !== "string") return line;
  const moved = movedPath(cwd, from, to);
  if (moved === undefined || moved === cwd) return line;
  // Replaced in place where the field is written compactly, so nothing else on the line changes
  // (numbers too large for a double stay exact). Otherwise the record is written again.
  const written = `"cwd":${JSON.stringify(cwd)}`;
  if (line.split(written).length === 2)
    return line.replace(written, `"cwd":${JSON.stringify(moved)}`);
  owner.cwd = moved;
  return JSON.stringify(record);
}

/** Every line of a JSONL session file, rewritten with `rewriteLine`; line endings kept. */
export function rewriteSession(text: string, from: string, to: string, holder: CwdHolder): string {
  return text
    .split("\n")
    .map((line) => {
      const carriage = line.endsWith("\r");
      const body = carriage ? line.slice(0, -1) : line;
      return rewriteLine(body, from, to, holder) + (carriage ? "\r" : "");
    })
    .join("\n");
}

/** Claude Code keeps a record's folder at its top level. */
export const claudeCwd: CwdHolder = (record) => record;

/** Codex keeps it in the payload of its session header and of each turn's context. */
export const codexCwd: CwdHolder = (record) =>
  (record.type === "session_meta" || record.type === "turn_context") && isRecord(record.payload)
    ? record.payload
    : undefined;

/**
 * The folder name Claude Code keeps a checkout's sessions under in `projects/`: every character
 * that isn't a letter or digit becomes `-`. Longer names than its limit are shortened by Claude
 * with a hash ace doesn't reproduce, so those are not carried.
 */
export function claudeProjectFolder(cwd: string): string | undefined {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length > 200 ? undefined : name;
}

/** Session ids a placed copy is renamed by: each original id, lowercase, to its fresh one. */
export type SessionIds = ReadonlyMap<string, string>;

type Found = { to: string; set(to: string): void };

/** Every string value in `value` equal to a renamed id, with how to replace it. */
function idValues(value: unknown, ids: SessionIds, out: Found[]): void {
  const visit = (item: unknown, set: (to: string) => void) => {
    const to = typeof item === "string" ? ids.get(item.toLowerCase()) : undefined;
    if (to !== undefined) out.push({ to, set });
    else idValues(item, ids, out);
  };
  if (Array.isArray(value))
    value.forEach((item, index) => visit(item, (to) => (value[index] = to)));
  else if (isRecord(value))
    for (const [key, item] of Object.entries(value)) visit(item, (to) => (value[key] = to));
}

/** The id as a whole JSON string on a line, any case. */
const quotedId = (id: string) =>
  new RegExp(JSON.stringify(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

/**
 * Renames one line's session ids: every string value equal to an id in `ids` (a record's
 * `sessionId`, a rollout header's `id` and the ids it forks from) becomes the fresh one.
 * A line that isn't JSON, or holds none of the ids, is kept byte for byte.
 */
export function renameLine(line: string, ids: SessionIds): string {
  if (!line.trim()) return line;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return line;
  }
  const found: Found[] = [];
  idValues(record, ids, found);
  if (!found.length) return line;
  // Replaced in place when each quoted id on the line is one of the values found (none is a
  // key or inside a longer string), so nothing else on the line changes.
  let inPlace = line;
  let counted = 0;
  for (const [from, to] of ids) {
    const pattern = quotedId(from);
    counted += line.match(pattern)?.length ?? 0;
    inPlace = inPlace.replace(pattern, JSON.stringify(to));
  }
  if (counted === found.length) return inPlace;
  for (const { to, set } of found) set(to);
  return JSON.stringify(record);
}

/** Every line of a JSONL session file, renamed with `renameLine`; line endings kept. */
export function renameSession(text: string, ids: SessionIds): string {
  if (!ids.size) return text;
  return text
    .split("\n")
    .map((line) => {
      const carriage = line.endsWith("\r");
      const body = carriage ? line.slice(0, -1) : line;
      return renameLine(body, ids) + (carriage ? "\r" : "");
    })
    .join("\n");
}
