// SPDX-License-Identifier: Apache-2.0

/*
 * Deterministic fixtures and their `--check` mode, shared by the `ace-fanout` vector
 * generators.
 *
 * A fixture must be reproducible from the TypeScript that produced it, or `check:daemon-native`
 * would compare a stale file and still pass. Two things in these generators are not
 * reproducible on their own: UUIDs (a Store's workspace, thread and event ids) and clock
 * readings (`Date.now()` in a row's `updatedAt`, a read cursor's `updatedAt`). `stable` maps
 * each distinct one, in first-appearance order, to a token that is the same everywhere it
 * appears — values and object keys alike — so the bytes are the same on every run and the Rust
 * test replays the same ids and times.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A clock reading, as a number or inside an embedded JSON string (an event's `at`). */
const CLOCK = /(?<!\d)1\d{12}(?!\d)/g;
/** The first token a clock reading becomes. */
const FIRST_TOKEN_TIME = 1_800_000_000_000;

/** Whether a number's text is a clock reading. */
const isClock = (text: string) => /^1\d{12}$/.test(text);

/** The fixture with every UUID and clock reading replaced by a stable token. */
export function stable(value: unknown): unknown {
  const ids = new Map<string, string>();
  const times = new Map<string, number>();
  const token = (seen: string): string => {
    let found = ids.get(seen);
    if (found === undefined) {
      found = `id-${ids.size + 1}`;
      ids.set(seen, found);
    }
    return found;
  };
  const clock = (key: string): number => {
    let found = times.get(key);
    if (found === undefined) {
      found = FIRST_TOKEN_TIME + times.size;
      times.set(key, found);
    }
    return found;
  };
  const walk = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      return entry
        .replace(UUID, (match) => token(match.toLowerCase()))
        .replace(CLOCK, (match) => String(clock(match)));
    }
    if (typeof entry === "number" && Number.isSafeInteger(entry) && isClock(String(entry))) {
      return clock(String(entry));
    }
    if (Array.isArray(entry)) return entry.map(walk);
    if (typeof entry === "object" && entry !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(entry)) {
        out[walk(key) as string] = walk(field);
      }
      return out;
    }
    return entry;
  };
  return walk(value);
}

/**
 * Write `value` to `path`, or with `--check` compare it and fail when the file is stale.
 * Returns whether the run was a check.
 */
export function writeVectors(path: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = "";
    }
    if (current !== text) {
      const script = process.argv[1] ?? "the generator";
      console.error(
        `stale vectors: ${relative(process.cwd(), path)} does not match ${relative(process.cwd(), script)}; run \`bun ${relative(process.cwd(), script)}\``,
      );
      process.exit(1);
    }
    console.log(`ok ${relative(process.cwd(), path)}`);
    return;
  }
  writeFileSync(path, text);
  console.log(`wrote ${path}`);
}
