import type { Recipe } from "@ace/protocol/marketplace";
import {
  contractFileReader,
  contractFileTexts,
  inlineContractFiles,
  type ArchiveFile,
} from "@ace/marketplace";

/*
 * What a new version of an agent package asks for that the old one didn't (ADR 0200 §6.1),
 * besides effects, whose switches Spade's plan names: a kind of trigger, a plugin, an app. Each
 * starts off. Pure: the review shows these as "Asks for more".
 */

const triggerWords: Record<string, string> = {
  schedule: "runs on a schedule",
  event: "starts when an agent thread finishes, fails or needs you",
  webhook: "starts when something posts to it on this machine",
  mention: "can be @-mentioned from threads and clubs",
};

function triggerKinds(recipe: Recipe): Set<string> {
  return new Set([
    ...(recipe.routines.length ? ["schedule"] : []),
    ...recipe.triggers.map((trigger) => trigger.kind),
  ]);
}

function apps(recipe: Recipe): Set<string> {
  return new Set(recipe.needs.connectors.map((need) => ("id" in need ? need.id : need.url)));
}

/** Sentences for what `next` asks for that `before` didn't. */
export function packageAsksMore(before: Recipe, next: Recipe): string[] {
  const asks: string[] = [];
  const kinds = triggerKinds(before);
  for (const kind of triggerKinds(next))
    if (!kinds.has(kind) && triggerWords[kind]) asks.push(`It ${triggerWords[kind]}.`);
  for (const plugin of next.plugins)
    if (!before.plugins.includes(plugin)) asks.push(`A plugin: ${plugin.slice(13)}.`);
  const had = apps(before);
  for (const app of apps(next)) if (!had.has(app)) asks.push(`An app: ${app}.`);
  return asks;
}

/** `bot.json` exactly as the verified bytes hold it, as text. */
export function bytesText(files: readonly ArchiveFile[]): string {
  const bot = files.find((file) => file.path === "bot.json");
  if (!bot) throw new Error("The package has no bot.json");
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bot.content);
}

/**
 * `bot.json` as Spade reads it: the verified bytes, with its contracts' schema files
 * (`contracts/<name>.json`) written in, as Spade writes them in (ADR 0200 §7).
 */
export function bytesJson(files: readonly ArchiveFile[]): unknown {
  return inlineContractFiles(JSON.parse(bytesText(files)), contractFileReader(files)).bot;
}

/**
 * Each component `bot.json` names (ADR 0203 §5), by path, in base64, as Spade takes them beside
 * the manifest (`code` on install and update). One that isn't in the archive is left out, and
 * Spade refuses the step for it.
 */
export function codeBytes(
  code: readonly { file: string }[] | undefined,
  files: readonly ArchiveFile[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { file } of code ?? []) {
    const found = files.find((entry) => entry.path === file);
    if (found) out[file] = Buffer.from(found.content).toString("base64");
  }
  return out;
}

/** The text of each schema file `bot.json`'s contracts name, by path, as Spade takes them. */
export function contractTexts(files: readonly ArchiveFile[]): Record<string, string> {
  return contractFileTexts(JSON.parse(bytesText(files)), files);
}
