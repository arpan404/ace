import type { CatalogModel, ProviderKind } from "@ace/protocol";
import { z } from "zod";
import { modelDisplayName } from "./display-name.ts";

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
const metadata = z
  .object({
    status: z.string().optional(),
    resolvedModel: z.string().min(1).max(256).optional(),
    resolvedModelId: z.string().min(1).max(256).optional(),
    aliases: z.array(z.string().min(1).max(256)).max(32).optional(),
    deprecated: z.boolean().optional(),
    legacy: z.boolean().optional(),
    internal: z.boolean().optional(),
    type: z.string().optional(),
    task: z.string().optional(),
    capabilities: z.object({ chat: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();
function readMetadata(row: CatalogModel) {
  try {
    return metadata.safeParse(JSON.parse(row.raw.json));
  } catch {
    return metadata.safeParse(null);
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
  const parsed = readMetadata(row);
  if (!parsed.success) return true;
  const info = parsed.data;
  return (
    !info.internal &&
    info.status !== "internal" &&
    info.capabilities?.chat !== false &&
    ![info.type, info.task].some(
      (value) =>
        value &&
        /^(?:embedding|rerank|transcription|image-generation|speech|internal)$/i.test(value),
    )
  );
}
function isLegacy(row: CatalogModel): boolean {
  const info = readMetadata(row);
  return Boolean(
    row.legacy ||
    row.deprecated ||
    (info.success &&
      (info.data.legacy ||
        info.data.deprecated ||
        /^(?:legacy|deprecated|retired)$/.test(info.data.status ?? ""))),
  );
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
  const byId = new Map<string, CatalogModel>();
  for (const original of usableRows) {
    const info = readMetadata(original);
    let canonical =
      original.resolvedModelId ??
      (info.success ? (info.data.resolvedModel ?? info.data.resolvedModelId) : undefined) ??
      original.id;
    const claudeAlias = /^(opus|sonnet|haiku)(?:-([\d][\d.-]*))?$/.exec(original.id);
    if (original.provider === "claude" && claudeAlias && !original.resolvedModelId) {
      const version = claudeAlias[2]?.replaceAll(".", "-");
      const prefix = `claude-${claudeAlias[1]}-${version ?? ""}`;
      const family = usableRows.filter((row) => row.id.startsWith(prefix)).toSorted(compareModels);
      canonical = family[0]?.id ?? original.id;
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
        ...(info.success ? (info.data.aliases ?? []) : []),
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
  const model =
    (rule.nativeFirst ? (native ?? preferred) : preferred) ?? available.toSorted(compareModels)[0];
  return model ? { model, source: "built-in" } : undefined;
}
