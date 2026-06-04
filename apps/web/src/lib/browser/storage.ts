export function normalizeBrowserStorageScopeId(scopeId: string | null | undefined): string | null {
  if (typeof scopeId !== "string") {
    return null;
  }
  const trimmedScopeId = scopeId.trim();
  return trimmedScopeId.length > 0 ? trimmedScopeId : null;
}

export function resolveScopedBrowserStorageKey(
  baseKey: string,
  scopeId: string | null | undefined,
): string {
  const normalizedScopeId = normalizeBrowserStorageScopeId(scopeId);
  return normalizedScopeId ? `${baseKey}:${encodeURIComponent(normalizedScopeId)}` : baseKey;
}

export const IN_APP_BROWSER_PARTITION = "persist:ace-browser";

export function resolveBrowserWebviewPartition(scopeId: string | null | undefined): string {
  const normalizedScopeId = normalizeBrowserStorageScopeId(scopeId);
  return normalizedScopeId
    ? `${IN_APP_BROWSER_PARTITION}:${encodeURIComponent(normalizedScopeId)}`
    : IN_APP_BROWSER_PARTITION;
}
