import type { PackageContract } from "@ace/protocol/marketplace";
import { readSchema, schemaMisfits, type Schema } from "./schema.ts";

/*
 * A package's contracts (ADR 0200 §7), read the way Spade reads them
 * (`spade_core::package::contract`): a name callers use, a one-line summary, input and output
 * schemas in the bounded subset, the effects a call may use (within the package's), and examples
 * that fit. `rules.json` holds both readers to the same refusals.
 *
 * A contract's name and schemas move with the package's versions, so a new version may not
 * break callers: `breakingChanges` compares it with the previous one. A breaking change takes a
 * new name.
 */

export const contractLimits = { contracts: 16, examples: 8, summaryChars: 200 } as const;

const fields = new Set(["name", "summary", "input", "output", "effects", "examples"]);
const declarable = new Set(["network", "publish", "send_as_person", "pay", "change_access"]);

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ContractReading {
  /** The contracts as the recipe keeps them: `read` and `write_local` left out of `effects`. */
  kept: unknown[];
  problems: string[];
}

/** Reads `contracts`; `declared` is every effect word the package declares. */
export function readContracts(raw: unknown, declared: readonly string[]): ContractReading {
  if (raw === undefined) return { kept: [], problems: [] };
  if (!Array.isArray(raw) || raw.length > contractLimits.contracts)
    return {
      kept: [],
      problems: [`contracts is a list of at most ${contractLimits.contracts}`],
    };
  const problems: string[] = [];
  const kept: unknown[] = [];
  const names: string[] = [];
  raw.forEach((item, i) => {
    const at = `contracts[${i}]`;
    if (!isFields(item)) {
      problems.push(`${at} is an object`);
      return;
    }
    // A schema file is written in before bot.json is read (`inlineContractFiles`); one still
    // named here was never read with it.
    if ("file" in item) {
      const path = typeof item["file"] === "string" ? item["file"] : "its schema file";
      problems.push(`${at}.file: ${path} isn't in the package`);
      return;
    }
    for (const key of Object.keys(item))
      if (!fields.has(key)) problems.push(`${at}.${key} isn't a field of a contract`);
    const name = item["name"];
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(name))
      problems.push(`${at}.name is lower-case words joined by _, like cheapest_fare`);
    else if (names.includes(name)) problems.push(`${at}: each contract has a name of its own`);
    else names.push(name);
    const summary = typeof item["summary"] === "string" ? item["summary"].trim() : "";
    if (!summary || [...summary].length > contractLimits.summaryChars)
      problems.push(
        `${at}.summary says in one line of at most ${contractLimits.summaryChars} characters what it answers`,
      );
    const input = readSchema(item["input"] ?? null, `${at}.input`);
    const output = readSchema(item["output"] ?? null, `${at}.output`);
    problems.push(...input.problems, ...output.problems);
    const effects: string[] = [];
    const words = item["effects"];
    if (words !== undefined && !Array.isArray(words))
      problems.push(`${at}.effects lists effect words`);
    for (const word of Array.isArray(words) ? words : []) {
      if (word === "read" || word === "write_local") continue;
      if (typeof word === "string" && declarable.has(word)) {
        if (declared.includes(word)) {
          if (!effects.includes(word)) effects.push(word);
        } else
          problems.push(
            `${at}.effects: ${word} isn't among the package's effects; a call can use only what the package declares`,
          );
      } else
        problems.push(
          `${at}.effects: ${JSON.stringify(word)} isn't an effect a call may use (network, publish, send_as_person, pay or change_access)`,
        );
    }
    const examples = item["examples"];
    if (
      examples !== undefined &&
      (!Array.isArray(examples) || examples.length > contractLimits.examples)
    )
      problems.push(`${at}.examples is a list of at most ${contractLimits.examples}`);
    else if (input.schema && output.schema)
      (examples ?? []).forEach((example: unknown, e: number) => {
        const here = `${at}.examples[${e}]`;
        if (!isFields(example) || !("input" in example) || !("output" in example)) {
          problems.push(`${here} has an input and the output it answers`);
          return;
        }
        for (const miss of [
          ...schemaMisfits(input.schema!, example["input"], `${here}.input`),
          ...schemaMisfits(output.schema!, example["output"], `${here}.output`),
        ])
          problems.push(`${miss.at}: ${miss.why}`);
      });
    const { file: _file, ...rest } = item;
    kept.push({ ...rest, effects });
  });
  return { kept, problems };
}

/**
 * Whether every value `narrow` takes, `wide` takes too, each place it doesn't said in words.
 * `input`: `wide` is the new input and `narrow` the old (callers send what the old one took).
 * Otherwise `wide` is the old output and `narrow` the new (callers read what the old one gave);
 * a field the new output adds is fine, since callers ignore what they don't know.
 */
function covers(wide: Schema, narrow: Schema, at: string, input: boolean, out: string[]) {
  if (wide.kind !== narrow.kind) {
    out.push(`${at} changed kind`);
    return;
  }
  if (wide.kind === "object" && narrow.kind === "object") {
    const [next, old] = input ? [wide, narrow] : [narrow, wide];
    for (const [name, field] of Object.entries(old.fields)) {
      const kept = next.fields[name];
      if (kept) covers(input ? kept : field, input ? field : kept, `${at}.${name}`, input, out);
      else if (input || old.required.includes(name)) out.push(`${at}.${name} is gone`);
    }
    if (input) {
      for (const name of next.required)
        if (!old.required.includes(name))
          out.push(
            name in old.fields
              ? `${at}.${name} became required`
              : `${at}.${name} is new and required`,
          );
    } else {
      for (const name of old.required)
        if (!next.required.includes(name) && name in next.fields)
          out.push(`${at}.${name} may be missing now`);
    }
  } else if (wide.kind === "string" && narrow.kind === "string") {
    if (wide.max < narrow.max)
      out.push(input ? `${at} takes less text (at most ${wide.max})` : `${at} may now be longer`);
    if (wide.min > narrow.min)
      out.push(input ? `${at} needs more text (at least ${wide.min})` : `${at} may now be shorter`);
    if (wide.oneOf) {
      const lost = (narrow.oneOf ?? []).filter((w) => !wide.oneOf!.includes(w));
      if (!narrow.oneOf)
        out.push(input ? `${at} became a choice of words` : `${at} may now be any text`);
      else if (lost.length)
        out.push(
          input
            ? `${at} no longer takes ${lost.join(", ")}`
            : `${at} may now be ${lost.join(", ")}`,
        );
    }
  } else if (wide.kind === "number" && narrow.kind === "number") {
    if (wide.integer && !narrow.integer)
      out.push(input ? `${at} became a whole number` : `${at} may now be a fraction`);
    if (wide.min !== undefined && (narrow.min === undefined || wide.min > narrow.min))
      out.push(input ? `${at} has a higher minimum` : `${at} may now be lower`);
    if (wide.max !== undefined && (narrow.max === undefined || wide.max < narrow.max))
      out.push(input ? `${at} has a lower maximum` : `${at} may now be higher`);
  } else if (wide.kind === "array" && narrow.kind === "array") {
    if (wide.max < narrow.max)
      out.push(
        input ? `${at} holds fewer items (at most ${wide.max})` : `${at} may now hold more items`,
      );
    if (wide.min > narrow.min)
      out.push(
        input ? `${at} needs more items (at least ${wide.min})` : `${at} may now hold fewer items`,
      );
    covers(wide.items, narrow.items, `${at}[]`, input, out);
  }
}

const read = (contract: PackageContract, side: "input" | "output") =>
  readSchema(contract[side], side).schema;

/**
 * What a new version's contracts break for callers of the previous version's: a contract gone,
 * an input that no longer takes what it took, or an output that may now hold what callers never
 * saw (a new optional output field is fine). Empty when callers keep working.
 */
export function breakingChanges(
  before: readonly PackageContract[],
  after: readonly PackageContract[],
): string[] {
  const out: string[] = [];
  for (const old of before) {
    const next = after.find((c) => c.name === old.name);
    if (!next) {
      out.push(`${old.name} is gone; callers of it would fail`);
      continue;
    }
    const [oldIn, newIn, oldOut, newOut] = [
      read(old, "input"),
      read(next, "input"),
      read(old, "output"),
      read(next, "output"),
    ];
    const changes: string[] = [];
    if (!newIn || !newOut) changes.push("its schemas don't read; `ace bot check` says why");
    // Callers send what the old input took: the new one must take it all.
    if (oldIn && newIn) covers(newIn, oldIn, "input", true, changes);
    // Callers read what the old output gave: the new one must give nothing it couldn't.
    if (oldOut && newOut) covers(oldOut, newOut, "output", false, changes);
    for (const change of changes) out.push(`${old.name}: ${change}`);
  }
  return out;
}
