import { ReleaseData } from "@ace/protocol";

/**
 * `ace-data.json`, published with every release (ADR 0174): the data formats that build reads
 * and writes, so an installed app can tell whether an older release can still read its home.
 * The numbers are the build's own constants, never typed by hand.
 */
export const releaseDataFile = "ace-data.json";

/**
 * Spade's schema version: the number of entries in `MIGRATIONS` in
 * `spade/crates/spade-store/src/schema.rs`, which `current_version()` returns. Counted from the
 * source so a release needs no Rust toolchain to say it.
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
 * `Migration {` openings at the list's own level: string literals (plain and raw) and anything
 * inside an entry's braces are skipped, so SQL that mentions a migration is never counted.
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
