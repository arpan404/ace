import type { CatalogModel } from "@ace/protocol";

/**
 * The model id a provider launches with. OpenCode rows already hold `provider/model` in
 * `nativeModelId`; Pi rows and custom upstream rows hold the bare id beside their upstream
 * provider, which is prefixed exactly once.
 */
export function executionModelId(
  row: Pick<CatalogModel, "nativeModelId" | "nativeProviderId">,
): string {
  const prefix = row.nativeProviderId && `${row.nativeProviderId}/`;
  return prefix && !row.nativeModelId.startsWith(prefix)
    ? `${prefix}${row.nativeModelId}`
    : row.nativeModelId;
}
