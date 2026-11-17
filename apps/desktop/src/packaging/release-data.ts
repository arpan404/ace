import { ReleaseData } from "@ace/protocol";

/**
 * `ace-data.json`, published with every release (ADR 0177): the data formats that build reads
 * and writes, so an installed app can tell whether an older release can still read its home.
 * The numbers are the build's own constants, never typed by hand.
 */
export const releaseDataFile = "ace-data.json";

/**
 * Spade's schema version as its source says: the number of entries in `MIGRATIONS` in
 * `spade/crates/spade-store/src/schema.rs`, which `current_version()` returns. A release takes
 * the number from the binary it ships (`spade --schema-version`) and uses this only as a
 * cross-check, refusing a binary built from other source; `release:data` on an older checkout,
 * whose binary can't say, uses it alone.
 */
export function spadeMigrationCount(source: string): number {
  const start = /const MIGRATIONS: &\[Migration\] = &\[\s*$/m.exec(source);
  if (!start) throw new Error("schema.rs has no MIGRATIONS list");
  const rest = source.slice(start.index + start[0].length);
  const end = /^\];\s*$/m.exec(rest);
  if (!end) throw new Error("schema.rs's MIGRATIONS list has no end");
  const count = topLevelEntries(rest.slice(0, end.index));
  if (count === 0) throw new Error("schema.rs's MIGRATIONS list is empty");
  return count;
}

/** The file's text: one JSON object, validated, ending in a newline. */
export function renderReleaseData(data: ReleaseData): string {
  return `${JSON.stringify(ReleaseData.parse(data))}\n`;
}

/**
 * `Migration {` openings at the list's own level: comments (line and nested block comments), string
 * literals (plain and raw) and anything inside an entry's braces are skipped, so a commented-out
 * entry or SQL that mentions a migration is never counted.
 */
function topLevelEntries(list: string): number {
  let depth = 0;
  let count = 0;
  let index = 0;
  while (index < list.length) {
    const rest = list.slice(index);
    const raw = /^r(#*)"/.exec(rest);
    if (raw) {
      const close = `"${raw[1] ?? ""}`;
      const end = list.indexOf(close, index + raw[0].length);
      index = end === -1 ? list.length : end + close.length;
      continue;
    }
    if (rest.startsWith("//")) {
      const end = list.indexOf("\n", index);
      index = end === -1 ? list.length : end + 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      index = blockCommentEnd(list, index);
      continue;
    }
    const char = list[index];
    if (char === '"') {
      index += 1;
      while (index < list.length && list[index] !== '"') index += list[index] === "\\" ? 2 : 1;
      index += 1;
      continue;
    }
    if (depth === 0 && /^Migration\s*\{/.test(rest)) count += 1;
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    index += 1;
  }
  return count;
}

/** Just past the block comment opening at `start`; Rust's block comments nest. */
function blockCommentEnd(text: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    if (text.startsWith("/*", index)) {
      depth += 1;
      index += 2;
    } else if (text.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
    } else index += 1;
  }
  return text.length;
}
