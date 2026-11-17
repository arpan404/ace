/**
 * Words for a value no renderer of its own covers yet (ADR 0176 §3: nothing prints indented
 * JSON to a person). Objects become aligned `name  value` lines, lists of objects one row
 * each, nested values indented under their name. Pure.
 */
export function humanize(value: unknown, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  if (value === null || value === undefined) return [];
  if (typeof value !== "object") return [`${pad}${scalar(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}None.`];
    return value.flatMap((item) => (isRecord(item) ? row(item, pad) : [`${pad}${scalar(item)}`]));
  }
  const entries = Object.entries(value).filter(
    ([, item]) => item !== undefined && item !== null && !(Array.isArray(item) && !item.length),
  );
  const width = Math.min(24, Math.max(0, ...entries.map(([name]) => words(name).length)));
  return entries.flatMap(([name, item]) => {
    const label = words(name);
    if (item !== null && typeof item === "object") {
      const inner = humanize(item, depth + 1);
      return inner.length ? [`${pad}${label}`].concat(inner) : [];
    }
    return [`${pad}${label.padEnd(width)}  ${scalar(item)}`];
  });
}

/** One object as one line: its identity first, then its short scalar fields. */
function row(item: Record<string, unknown>, pad: string): string[] {
  const first = ["id", "name", "title", "label"].find((key) => typeof item[key] === "string");
  const parts: string[] = [];
  if (first) parts.push(String(item[first]));
  for (const [key, value] of Object.entries(item)) {
    if (key === first || value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    const text = scalar(value);
    if (text.length > 60) continue;
    parts.push(typeof value === "boolean" ? (value ? words(key) : "") : text);
  }
  return [`${pad}${parts.filter(Boolean).join("  ")}`];
}

function scalar(value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

/** `threadId` → `thread id`, `last_seen` → `last seen`. */
function words(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

/** What `--quiet` prints for a value: its identifiers, one per line. */
export function identifiers(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => identifiers(item).slice(0, 1));
  if (!isRecord(value)) return [];
  const record = value;
  for (const key of ["threadId", "id", "requestId", "ref", "planId", "path"])
    if (typeof record[key] === "string") return [String(record[key])];
  for (const item of Object.values(record))
    if (Array.isArray(item) && item.length) return identifiers(item);
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
