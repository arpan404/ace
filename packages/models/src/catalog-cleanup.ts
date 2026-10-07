import type { CatalogModel, ProviderKind } from "@ace/protocol";
import { classifyCatalog, compareVersions } from "./catalog-classification.ts";
import { modelDisplayName } from "./display-name.ts";

/** Preference rules only rank reported choices. They never manufacture model IDs. */
export const providerDefaultRules: Record<
  ProviderKind,
  {
    families: readonly string[];
  }
> = {
  claude: {
    families: ["claude-opus", "opus", "claude-sonnet", "sonnet", "claude-haiku", "haiku"],
  },
  codex: {
    families: ["gpt-sol", "gpt-codex", "gpt", "gpt-luna", "o3", "o4", "o1"],
  },
  cursor: {
    families: [
      "composer",
      "claude-opus",
      "gpt-sol",
      "gpt",
      "claude-sonnet",
      "gemini",
      "grok",
      "auto",
    ],
  },
  opencode: {
    families: [
      "muse-spark",
      "claude-opus",
      "gpt-sol",
      "gpt-codex",
      "gpt",
      "gpt-luna",
      "claude-sonnet",
      "gemini",
      "grok",
      "kimi",
      "qwen",
      "glm",
      "deepseek",
    ],
  },
  pi: {
    families: [
      "claude-opus",
      "gpt-sol",
      "gpt-codex",
      "gpt",
      "gpt-luna",
      "claude-sonnet",
      "gemini",
      "grok",
      "kimi",
      "qwen",
      "glm",
      "deepseek",
    ],
  },
  acp: { families: [] },
  antigravity: { families: ["gemini", "claude-opus", "gpt"] },
};

export function isDefaultSelection(id: string | undefined): boolean {
  return id !== undefined && /^(?:default(?:\s*\(recommended\))?)$/i.test(id.trim());
}
/** The model's own name: OpenCode keeps its upstream provider prefix in `nativeModelId`. */
function modelName(row: CatalogModel): string {
  const prefix = row.nativeProviderId && `${row.nativeProviderId}/`;
  return prefix && row.nativeModelId.startsWith(prefix)
    ? row.nativeModelId.slice(prefix.length)
    : row.nativeModelId;
}
function usable(row: CatalogModel): boolean {
  if (isDefaultSelection(row.id) || isDefaultSelection(modelName(row))) return false;
  // These names describe non-chat endpoints, not coding models. Unknown names remain usable.
  if (
    /(?:^|[-_/ ])(?:embedding?s?|rerank(?:er)?|whisper|tts|dall-e|gpt-image|sora|moderation|internal)(?:$|[-_/ ])/i.test(
      modelName(row),
    )
  )
    return false;
  if (row.inputModalities.length && !row.inputModalities.includes("text")) return false;
  // Semantic filtering belongs to native decoding, before bounded diagnostic raw is made.
  return true;
}
function isLegacy(row: CatalogModel): boolean {
  return Boolean(row.legacy || row.deprecated);
}
function familyRank(row: CatalogModel): number {
  const families = providerDefaultRules[row.provider].families;
  const native = modelName(row);
  const name = native.slice(native.lastIndexOf("/") + 1);
  const index = families.findIndex((family) =>
    row.family === family
      ? true
      : row.family && family.startsWith("gpt")
        ? row.family === family
        : family === "gpt-sol"
          ? /^gpt[-.\d]+-sol(?:$|-)/.test(name)
          : family === "gpt-codex"
            ? /^gpt[-.\d]+-codex(?:$|-)/.test(name)
            : name.toLowerCase().startsWith(family),
  );
  return index < 0 ? families.length : index;
}
const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export function compareModels(a: CatalogModel, b: CatalogModel): number {
  if (a.sortKey && b.sortKey) return a.sortKey.localeCompare(b.sortKey, "en");
  const legacy =
    Number(Boolean(a.legacy || a.deprecated)) - Number(Boolean(b.legacy || b.deprecated));
  if (legacy) return legacy;
  const family = familyRank(a) - familyRank(b);
  if (family) return family;
  const known = familyRank(a) < providerDefaultRules[a.provider].families.length;
  return (
    (a.version && b.version ? compareVersions(b.version, a.version) : 0) ||
    (known ? natural.compare(modelName(b), modelName(a)) : natural.compare(a.id, b.id)) ||
    a.id.localeCompare(b.id, "en")
  );
}

/** Deduplicate selector identities across groups, retaining provider-qualified routes. */
export function cleanCatalog(models: readonly CatalogModel[]): CatalogModel[] {
  const usableRows = models.filter(usable);
  // Index exact numeric prefixes once; an alias never rescans/sorts the catalog.
  const claudeFamilies = new Map<string, CatalogModel>();
  for (const row of usableRows) {
    if (row.provider !== "claude") continue;
    const match = /^claude-(opus|sonnet|haiku)-(.+)$/.exec(row.id);
    if (!match?.[1] || !match[2]) continue;
    let key = match[1];
    const keys = [key];
    for (const part of match[2].split("-")) {
      if (!/^\d+$/.test(part)) break;
      key += `-${part}`;
      keys.push(key);
    }
    for (const prefix of keys) {
      const previous = claudeFamilies.get(prefix);
      if (!previous || compareModels(row, previous) < 0) claudeFamilies.set(prefix, row);
    }
  }
  const byId = new Map<string, CatalogModel>();
  for (const original of usableRows) {
    let canonical = original.resolvedModelId ?? original.id;
    const claudeAlias = /^(opus|sonnet|haiku)(?:-([\d][\d.-]*))?$/.exec(original.id);
    if (original.provider === "claude" && claudeAlias && canonical === original.id) {
      const version = claudeAlias[2]?.replaceAll(".", "-");
      const key = `${claudeAlias[1]}${version ? `-${version}` : ""}`;
      canonical = claudeFamilies.get(key)?.id ?? original.id;
    }
    if (original.nativeProviderId && !canonical.startsWith(`${original.nativeProviderId}/`))
      canonical = `${original.nativeProviderId}/${canonical}`;
    const previous = byId.get(canonical);
    const chosen = !previous
      ? original
      : isLegacy(original) !== isLegacy(previous)
        ? isLegacy(original)
          ? previous
          : original
        : original.id === canonical
          ? original
          : previous;
    const legacy = isLegacy(chosen);
    const aliases = [
      ...new Set([
        ...(previous?.aliases ?? []),
        ...(original.aliases ?? []),
        ...(original.id !== canonical ? [original.id] : []),
      ]),
    ]
      .filter((id) => id !== canonical && !isDefaultSelection(id))
      .slice(0, 32);
    const name =
      chosen.id !== canonical || /^(?:opus|sonnet|haiku)$/i.test(chosen.displayName)
        ? modelDisplayName(canonical).displayName
        : modelDisplayName(canonical, chosen.displayName).displayName;
    byId.set(canonical, {
      ...chosen,
      id: canonical,
      nativeModelId: chosen.provider === "claude" ? canonical : chosen.nativeModelId,
      displayName: name,
      ...(aliases.length ? { aliases } : {}),
      isDefault: original.isDefault || previous?.isDefault || false,
      legacy: Boolean(legacy),
      group: legacy ? "legacy" : "current",
    });
  }
  return (
    classifyCatalog([...byId.values()])
      // oxlint-disable-next-line oxc/no-map-spread -- Clone immutable cached values for this view.
      .map((row) => ({
        ...row,
        sortKey:
          `${row.tier === "current" ? "0" : "1"}:${String(familyRank(row)).padStart(3, "0")}:${row.sortKey ?? row.id}`.slice(
            0,
            256,
          ),
      }))
      .toSorted(compareModels)
  );
}

export function matchesModel(row: CatalogModel, id: string): boolean {
  return row.id === id || row.resolvedModelId === id || row.aliases?.includes(id) === true;
}
export function defaultModel(
  models: readonly CatalogModel[],
  provider: ProviderKind,
  override?: string,
): { model: CatalogModel; source: "built-in" | "user" } | undefined {
  const available = models.filter(
    (row) => !row.hidden && !row.deprecated && !row.legacy && row.providerEnabled !== false,
  );
  const user =
    override && !isDefaultSelection(override)
      ? models.find(
          (row) =>
            row.providerEnabled !== false &&
            (!row.hidden || row.visibilityReason === "deprecated") &&
            matchesModel(row, override),
        )
      : undefined;
  if (user) return { model: user, source: "user" };
  const rule = providerDefaultRules[provider];
  const native = available.find((row) => row.isDefault);
  let fallback: CatalogModel | undefined;
  for (const row of available) if (!fallback || compareModels(row, fallback) < 0) fallback = row;
  const model =
    fallback && familyRank(fallback) < rule.families.length ? fallback : (native ?? fallback);
  return model ? { model, source: "built-in" } : undefined;
}
