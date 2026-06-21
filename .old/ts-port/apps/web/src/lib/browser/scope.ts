export type BrowserPanelPlacement = "bottom" | "right";

const BROWSER_SCOPE_SEPARATOR = ":browser:";

export function resolveBrowserInstanceScopeId(input: {
  placement: BrowserPanelPlacement;
  threadId: string;
  windowInstanceId?: string | null | undefined;
}): string {
  const normalizedWindowInstanceId = input.windowInstanceId?.trim();
  const baseScopeId = `${input.threadId}${BROWSER_SCOPE_SEPARATOR}${input.placement}`;
  return normalizedWindowInstanceId
    ? `${baseScopeId}:window:${normalizedWindowInstanceId}`
    : baseScopeId;
}

export function resolveBrowserThreadIdFromScopeId(
  scopeId: string | null | undefined,
): string | null {
  if (!scopeId) {
    return null;
  }
  const [threadId, browserScope] = scopeId.split(BROWSER_SCOPE_SEPARATOR);
  return threadId && browserScope !== undefined ? threadId : null;
}
