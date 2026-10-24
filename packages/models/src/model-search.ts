import type { CatalogModel } from "@ace/protocol";
import { matchesModel } from "./model-selection.ts";

/** A name's words, and its versions: runs of numbers with no word between them. */
interface Parts {
  words: string[];
  versions: string[][];
}

/** "GPT-6.1 Sol" is words gpt, sol and version 6.1; "qwen3-coder:480b" has versions 3 and 480. */
function parts(text: string): Parts {
  const words: string[] = [];
  const versions: string[][] = [];
  let version: string[] | undefined;
  for (const token of text.toLowerCase().match(/[a-z]+|[0-9]+/g) ?? []) {
    if (/^[a-z]/.test(token)) {
      words.push(token);
      version = undefined;
    } else if (version) version.push(token);
    else {
      version = [token];
      versions.push(version);
    }
  }
  return { words, versions };
}

const startsWith = (version: readonly string[], prefix: readonly string[]) =>
  prefix.length <= version.length && prefix.every((number, at) => version[at] === number);

/**
 * How far one name is from the query, or undefined when the query asks for something it lacks.
 * Every query word must appear once (words of three or more letters may be a prefix), and each
 * version the query writes must begin one of the name's versions, in order: "opus 4" fits Opus
 * 4.8, while "opus 5" never fits Opus 4.5 and "5.4" never fits 4.5. Each extra word in the name
 * costs one, so "muse spark" is nearer "Muse Spark 1.3" than "Muse Spark 1.3 Contributor". Extra
 * numbers count only when the query names a version: "opus" fits every Opus equally (the newest
 * wins the tie), while "opus 5" means Opus 5, not Opus 5.5.
 */
function distance(query: Parts, name: string): number | undefined {
  const { words, versions } = parts(name);
  const used = words.map(() => false);
  let cost = 0;
  for (const word of query.words) {
    let index = words.findIndex((candidate, at) => !used[at] && candidate === word);
    if (index < 0 && word.length >= 3) {
      index = words.findIndex((candidate, at) => !used[at] && candidate.startsWith(word));
      cost += 0.25;
    }
    if (index < 0) return undefined;
    used[index] = true;
  }
  cost += used.filter((taken) => !taken).length;
  let next = 0;
  let matched = 0;
  for (const wanted of query.versions) {
    const at = versions.findIndex((version, index) => index >= next && startsWith(version, wanted));
    if (at < 0) return undefined;
    next = at + 1;
    matched += wanted.length;
  }
  if (query.versions.length) cost += versions.flat().length - matched;
  return cost;
}

/** -1 for an exact id or alias, else the nearest of the model's names; undefined when none fit. */
function score(model: CatalogModel, raw: string, query: Parts): number | undefined {
  if (matchesModel(model, raw)) return -1;
  let best: number | undefined;
  const names = [model.id, model.displayName, model.nativeModelId, model.resolvedModelId];
  for (const name of [...names, ...(model.aliases ?? [])]) {
    if (!name) continue;
    const routed = name.lastIndexOf("/");
    for (const candidate of routed < 0 ? [name] : [name, name.slice(routed + 1)]) {
      const found = distance(query, candidate);
      if (found !== undefined && (best === undefined || found < best)) best = found;
    }
  }
  // A model served through a gateway ("openai-codex/gpt-6.1-sol") ranks after the same model
  // from the provider that makes it.
  return best === undefined ? undefined : best + (model.id.includes("/") ? 0.5 : 0);
}

const legacy = (model: CatalogModel) =>
  model.tier === "legacy" || model.legacy === true || model.group === "legacy";

/**
 * Catalog rows whose names fit `query`, nearest first. Ties keep current models before legacy
 * ones, then the catalog's own order (newest first within a family). One row per account, so
 * the same model on two accounts appears twice.
 */
export function searchModels(models: readonly CatalogModel[], query: string): CatalogModel[] {
  const tokens = parts(query);
  if (!tokens.words.length && !tokens.versions.length) return [];
  const scored: { model: CatalogModel; score: number; order: number }[] = [];
  for (const [order, model] of models.entries()) {
    const found = score(model, query.trim(), tokens);
    if (found !== undefined) scored.push({ model, score: found, order });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      Number(legacy(a.model)) - Number(legacy(b.model)) ||
      (a.model.sortKey && b.model.sortKey ? a.model.sortKey.localeCompare(b.model.sortKey) : 0) ||
      a.order - b.order,
  );
  return scored.map((entry) => entry.model);
}

export type ModelNameMatch =
  | { kind: "match"; model: CatalogModel }
  | { kind: "ambiguous"; options: CatalogModel[] }
  | { kind: "none" };

/**
 * The one model a name means. Several equally near models resolve only when they are versions of
 * one family from one provider ("opus 4" picks the newest Opus 4); otherwise the caller gets the
 * options to choose from, never a silent guess.
 */
export function resolveModelName(models: readonly CatalogModel[], query: string): ModelNameMatch {
  const found = searchModels(models, query);
  const first = found[0];
  if (!first) return { kind: "none" };
  const tokens = parts(query);
  const nearest = score(first, query.trim(), tokens);
  const tied = new Map<string, CatalogModel>();
  for (const model of found) {
    if (score(model, query.trim(), tokens) !== nearest) break;
    const key = `${model.provider}\u0000${model.id}`;
    if (!tied.has(key)) tied.set(key, model);
  }
  const options = [...tied.values()];
  const oneFamily =
    first.family !== undefined &&
    options.every((model) => model.provider === first.provider && model.family === first.family);
  return options.length === 1 || oneFamily
    ? { kind: "match", model: first }
    : { kind: "ambiguous", options };
}
