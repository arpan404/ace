import type { CatalogModel, ProviderKind } from "@ace/protocol";
import { modelDisplayName } from "./display-name.ts";

/** Routing aliases with provider-specific lifecycle semantics, rather than numeric versions. */
const overrides: Partial<Record<ProviderKind, Readonly<Record<string, "current" | "legacy">>>> = {
  cursor: { auto: "current" },
  codex: { "gpt-5-codex-mini": "legacy" },
};
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
function scope(row: CatalogModel): string {
  return JSON.stringify([row.provider, row.instance, row.nativeProviderId, row.family]);
}
export function classifyCatalog(rows: readonly CatalogModel[]): CatalogModel[] {
  const named = rows.map((row) =>
    Object.assign({}, row, modelDisplayName(row.id, row.displayName)),
  );
  const newest = new Map<string, string>();
  for (const row of named) {
    if (!row.family || !row.version) continue;
    const key = scope(row);
    const previous = newest.get(key);
    if (!previous || compareVersions(row.version, previous) > 0) newest.set(key, row.version);
  }
  return named.map((row) => {
    const override = overrides[row.provider]?.[row.id];
    const older =
      row.family &&
      row.version &&
      compareVersions(row.version, newest.get(scope(row)) ?? row.version) < 0;
    const tier =
      row.deprecated || row.legacy || override === "legacy" || (override !== "current" && older)
        ? "legacy"
        : "current";
    const versionKey = Array.from(
      { length: 4 },
      (_, index) => (row.version ?? "0").split(".")[index] ?? "0",
    )
      .map((part) => String(Math.max(0, 999999 - Number(part))).padStart(6, "0"))
      .join(".");
    return Object.assign(row, {
      tier,
      legacy: tier === "legacy",
      group: tier,
      sortKey:
        `${tier === "current" ? "0" : "1"}:${row.family ?? row.id}:${versionKey}:${row.id}`.slice(
          0,
          256,
        ),
      source: row.source ?? {
        kind: row.nativeProviderId ? "other" : "account",
        id: row.nativeProviderId ?? row.instance,
        label: row.nativeProviderId ?? row.instance,
      },
    });
  });
}
