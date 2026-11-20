import type { Recipe } from "@ace/protocol/marketplace";
import type { ArchiveFile } from "@ace/marketplace";

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

/** `bot.json` as the verified bytes hold it. */
export function bytesJson(files: readonly ArchiveFile[]): unknown {
  return JSON.parse(bytesText(files));
}
