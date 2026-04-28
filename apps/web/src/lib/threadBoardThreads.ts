import type { ThreadId } from "@ace/contracts";

export function normalizeThreadBoardConnectionUrl(
  connectionUrl: string | null | undefined,
): string | null {
  const normalized = connectionUrl?.trim();
  return normalized ? normalized : null;
}

export function buildThreadBoardThreadKey(
  threadId: ThreadId,
  connectionUrl: string | null | undefined,
): string {
  return `${normalizeThreadBoardConnectionUrl(connectionUrl) ?? "local"}:${threadId}`;
}
