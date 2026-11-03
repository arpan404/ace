/*
 * The ledger modules the moving sample pull request changes, generated rather than typed out:
 * each before the PR, after its change, and the ones it adds.
 */

const pascal = (name: string) =>
  name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

/** A module of the ledger before the PR: filter one currency's entries, then total them. */
export function baseSource(area: string, name: string, index: number): string[] {
  const type = pascal(name);
  const extra = Array.from({ length: index % 3 }, (_, n) => [
    "",
    `export function ${name.replace(/-./g, (m) => m.charAt(1).toUpperCase())}Page${n + 1}(entries: readonly Entry[], page: number): Entry[] {`,
    `  return entries.slice((page - 1) * ${25 * (n + 1)}, page * ${25 * (n + 1)});`,
    "}",
  ]).flat();
  return [
    'import type { Entry, Ledger } from "../ledger.ts";',
    'import { cents } from "../money.ts";',
    "",
    `/** ${type} entries of one ${area === "accounts" ? "account" : "ledger"}, in ${area}. */`,
    `export interface ${type}Options {`,
    "  limit: number;",
    "  currency: string;",
    "}",
    "",
    `export function select${type}(ledger: Ledger, options: ${type}Options): Entry[] {`,
    "  const entries = ledger.entries.filter((entry) => entry.currency === options.currency);",
    "  const kept: Entry[] = [];",
    "  for (const entry of entries) {",
    "    if (kept.length >= options.limit) break;",
    "    kept.push(entry);",
    "  }",
    "  return kept;",
    "}",
    "",
    `export function total${type}(entries: readonly Entry[]): number {`,
    "  let sum = 0;",
    "  for (const entry of entries) sum += cents(entry.amount);",
    "  return sum;",
    "}",
    ...extra,
  ];
}

/** The PR's change to a module: entries stream one account at a time, oldest first. */
export function streamed(lines: string[], area: string): string[] {
  const next = [...lines];
  next.splice(
    12,
    1,
    "  const seen = new Set<string>();",
    `  // ${area}: one stream per account, oldest first.`,
    "  const ordered = [...entries].sort((a, b) => a.at - b.at);",
    "  for (const entry of ordered) {",
  );
  // After the loop's limit check, now line 17.
  next.splice(17, 0, "    if (seen.has(entry.account)) continue;", "    seen.add(entry.account);");
  return next;
}

/** A module the PR adds whole. */
export function addedSource(area: string, name: string): string[] {
  const type = pascal(name);
  return [
    'import type { Entry } from "../ledger.ts";',
    "",
    `/** Plays ${area} entries back in order, one account at a time. */`,
    `export function ${type.charAt(0).toLowerCase()}${type.slice(1)}(entries: readonly Entry[]): Map<string, Entry[]> {`,
    "  const streams = new Map<string, Entry[]>();",
    "  for (const entry of entries) {",
    "    const stream = streams.get(entry.account) ?? [];",
    "    stream.push(entry);",
    "    streams.set(entry.account, stream);",
    "  }",
    "  return streams;",
    "}",
  ];
}
