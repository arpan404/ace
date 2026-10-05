import type { CatalogModel, ProviderKind } from "@ace/protocol";
import { modelDisplayName } from "./display-name.ts";
import { catalogMetadata, chatMetadata, legacyMetadata } from "./catalog-metadata.ts";

/** Preference rules only rank reported choices. They never manufacture model IDs. */
export const providerDefaultRules: Record<
  ProviderKind,
  {
    preferred: readonly string[];
    families: readonly string[];
    nativeFirst: boolean;
  }
> = {
  claude: {
    preferred: ["claude-opus-5-5"],
    families: ["claude-opus", "opus", "claude-sonnet", "sonnet", "claude-haiku", "haiku"],
    nativeFirst: false,
  },
  codex: {
    preferred: ["gpt-6.1-sol"],
    families: ["gpt-sol", "gpt-codex", "gpt", "o3", "o4", "o1"],
    nativeFirst: false,
  },
  cursor: {
    preferred: ["auto"],
    families: ["auto", "claude-opus", "gpt", "claude-sonnet", "gemini", "grok"],
    nativeFirst: false,
  },
  opencode: {
    preferred: ["opencode-go/muse-spark-1.3-contributor"],
    families: [
      "muse-spark",
      "claude-opus",
      "gpt",
      "claude-sonnet",
      "gemini",
      "grok",
      "kimi",
      "qwen",
      "glm",
      "deepseek",
    ],
    nativeFirst: true,
  },
  pi: {
    preferred: [],
    families: [
      "claude-opus",
      "gpt",
      "claude-sonnet",
      "gemini",
      "grok",
      "kimi",
      "qwen",
      "glm",
      "deepseek",
    ],
    nativeFirst: true,
  },
  acp: { preferred: [], families: [], nativeFirst: true },
  antigravity: { preferred: [], families: ["gemini", "claude-opus", "gpt"], nativeFirst: true },
};

export function isDefaultSelection(id: string | undefined): boolean {
  return id !== undefined && /^(?:default(?:\s*\(recommended\))?)$/i.test(id.trim());
}
function readMetadata(row: CatalogModel) {
  try {
    return catalogMetadata(JSON.parse(row.raw.json));
  } catch {
    return catalogMetadata(null);
  }
}
function usable(row: CatalogModel): boolean {
  if (isDefaultSelection(row.id) || isDefaultSelection(row.nativeModelId)) return false;
  // These names describe non-chat endpoints, not coding models. Unknown names remain usable.
  if (
    /(?:^|[-_/ ])(?:embedding?s?|rerank(?:er)?|whisper|tts|dall-e|gpt-image|sora|moderation|internal)(?:$|[-_/ ])/i.test(
      row.nativeModelId,
    )
  )
    return false;
  if (row.inputModalities.length && !row.inputModalities.includes("text")) return false;
  return chatMetadata(readMetadata(row));
}
function isLegacy(row: CatalogModel): boolean {
  return Boolean(row.legacy || row.deprecated || legacyMetadata(readMetadata(row)));
}
function familyRank(row: CatalogModel): number {
  const families = providerDefaultRules[row.provider].families;
  const index = families.findIndex((family) =>
    family === "gpt-sol"
      ? /^gpt[-.\d]+-sol(?:$|-)/.test(row.nativeModelId)
      : family === "gpt-codex"
        ? /^gpt[-.\d]+-codex(?:$|-)/.test(row.nativeModelId)
        : row.nativeModelId.toLowerCase().startsWith(family),
  );
  return index < 0 ? families.length : index;
}
const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export function compareModels(a: CatalogModel, b: CatalogModel): number {
  const legacy =
    Number(Boolean(a.legacy || a.deprecated)) - Number(Boolean(b.legacy || b.deprecated));
  if (legacy) return legacy;
  const family = familyRank(a) - familyRank(b);
  if (family) return family;
  const known = familyRank(a) < providerDefaultRules[a.provider].families.length;
  return (
    (known ? natural.compare(b.nativeModelId, a.nativeModelId) : natural.compare(a.id, b.id)) ||
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
    const info = readMetadata(original);
    let canonical =
      original.resolvedModelId ?? info.resolvedModel ?? info.resolvedModelId ?? original.id;
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
        ...(info.aliases ?? []),
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
  return [...byId.values()].toSorted(compareModels);
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
      ? available.find((row) => matchesModel(row, override))
      : undefined;
  if (user) return { model: user, source: "user" };
  const rule = providerDefaultRules[provider];
  const native = available.find((row) => row.isDefault);
  const preferred = rule.preferred
    .map((id) => available.find((row) => matchesModel(row, id)))
    .find((row) => row !== undefined);
  let fallback: CatalogModel | undefined;
  for (const row of available) if (!fallback || compareModels(row, fallback) < 0) fallback = row;
  const model = (rule.nativeFirst ? (native ?? preferred) : preferred) ?? fallback;
  return model ? { model, source: "built-in" } : undefined;
}
