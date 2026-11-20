import type { ArchiveFile } from "./archive.ts";
import { text } from "./listing.ts";

/*
 * A contract's schemas in a file of the package (ADR 0200 §3.1, §7): `"file":
 * "contracts/<name>.json"` in place of `input` and `output`, the file holding just those two.
 * They are written into the contract before `bot.json` is read, so every reader sees one form;
 * Spade does the same (`spade_core::package::contract_files`), and for a market package takes
 * each file only as the signed manifest lists it, so the signature covers the schemas as it
 * covers `bot.json`. `rules.json` holds both to the same refusals. Pure.
 */

/** The largest schema file: two schemas of at most 16 KiB each, with room around them. */
export const mostContractFileBytes = 40 * 1024;

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `path` is where a contract's schemas may live: `contracts/<name>.json`. */
export const contractSchemaPath = (path: string) =>
  /^contracts\/[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(path);

/** The schema files `bot`'s contracts name. */
export function contractFiles(bot: unknown): string[] {
  const contracts = isFields(bot) ? bot["contracts"] : undefined;
  return Array.isArray(contracts)
    ? contracts.flatMap((item) =>
        isFields(item) && typeof item["file"] === "string" ? [item["file"]] : [],
      )
    : [];
}

export interface InlinedContracts {
  /** `bot` with each schema file written in; a contract whose file failed is left out. */
  bot: unknown;
  problems: string[];
}

/**
 * `bot` (a `bot.json` value) with each contract that names a schema file holding that file's
 * `input` and `output` instead, read with `read` (a path to its text, if the package has it).
 * A `bot` whose contracts name no file comes back as it is.
 */
export function inlineContractFiles(
  bot: unknown,
  read: (path: string) => string | undefined,
): InlinedContracts {
  const contracts = isFields(bot) ? bot["contracts"] : undefined;
  if (!isFields(bot) || !Array.isArray(contracts) || contractFiles(bot).length === 0)
    return { bot, problems: [] };
  const problems: string[] = [];
  const written: unknown[] = [];
  contracts.forEach((item, i) => {
    if (!isFields(item) || !("file" in item)) {
      written.push(item);
      return;
    }
    const at = `contracts[${i}]`;
    const one = fromFile(item, at, read);
    if (typeof one === "string") problems.push(one);
    else written.push(one);
  });
  return { bot: { ...bot, contracts: written }, problems };
}

/** One contract's fields with its file's schemas written in, or why not. */
function fromFile(item: Fields, at: string, read: (path: string) => string | undefined) {
  const path = typeof item["file"] === "string" ? item["file"] : "";
  if (!contractSchemaPath(path))
    return `${at}.file is contracts/<name>.json, like contracts/cheapest-fare.json`;
  if ("input" in item || "output" in item)
    return `${at}: write its schemas either in bot.json or in ${path}, not both`;
  const source = read(path);
  if (source === undefined) return `${at}.file: ${path} isn't in the package`;
  if (new TextEncoder().encode(source).byteLength > mostContractFileBytes)
    return `${path} is larger than 40 KiB`;
  let schemas: unknown;
  try {
    schemas = JSON.parse(source);
  } catch {
    schemas = undefined;
  }
  if (!isFields(schemas)) return `${path} isn't a JSON object of input and output`;
  const other = Object.keys(schemas).find((key) => key !== "input" && key !== "output");
  if (other !== undefined)
    return `${path}: ${other} isn't a field of a schema file; it holds only input and output`;
  const { file: _file, ...rest } = item;
  return { ...rest, input: schemas["input"] ?? null, output: schemas["output"] ?? null };
}

/** A package's files as `inlineContractFiles` reads them: a schema file's text, if it has one. */
export function contractFileReader(files: readonly ArchiveFile[]) {
  return (path: string) =>
    contractSchemaPath(path) ? text(files.find((file) => file.path === path)?.content) : undefined;
}

/** The text of each schema file `bot`'s contracts name, by path, as Spade takes them beside a
 * signed `bot.json` (the envelope's `files`). One that isn't text is left out. */
export function contractFileTexts(
  bot: unknown,
  files: readonly ArchiveFile[],
): Record<string, string> {
  const read = contractFileReader(files);
  const out: Record<string, string> = {};
  for (const path of contractFiles(bot)) {
    const source = read(path);
    if (source !== undefined) out[path] = source;
  }
  return out;
}
