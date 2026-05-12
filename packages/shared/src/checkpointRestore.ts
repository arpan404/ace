import { type ProviderKind } from "@ace/contracts";

export const TRANSCRIPT_REBUILD_PROVIDERS = new Set<ProviderKind>([
  "githubCopilot",
  "cursor",
  "pi",
  "gemini",
  "opencode",
]);

export function usesTranscriptRebuildRestore(provider: ProviderKind | null | undefined): boolean {
  return provider !== null && provider !== undefined && TRANSCRIPT_REBUILD_PROVIDERS.has(provider);
}

export function buildCheckpointRestoreConfirmation(
  provider: ProviderKind | null | undefined,
  turnCount: number,
): string {
  if (usesTranscriptRebuildRestore(provider)) {
    return [
      `Restore to checkpoint ${turnCount}?`,
      "Newer messages, turn diffs, and file changes will be discarded.",
    ].join("\n");
  }

  return [
    `Revert to checkpoint ${turnCount}?`,
    "Newer messages, turn diffs, and file changes will be discarded.",
  ].join("\n");
}

export function checkpointRestoreActionTitle(provider: ProviderKind | null | undefined): string {
  return usesTranscriptRebuildRestore(provider)
    ? "Restore files and rebuild from this message"
    : "Revert to this message";
}

export function checkpointRestoreFailureMessage(provider: ProviderKind | null | undefined): string {
  return usesTranscriptRebuildRestore(provider)
    ? "Failed to restore thread state."
    : "Failed to revert thread state.";
}
