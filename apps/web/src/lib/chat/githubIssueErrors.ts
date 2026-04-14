export function normalizeGitHubIssueErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  const message = error.message.trim();
  const lower = message.toLowerCase();
  if (
    lower.includes("has disabled issues") ||
    lower.includes("issues are disabled") ||
    lower.includes("disabled for this repository")
  ) {
    return "GitHub issues are disabled for this repository. Enable Issues in repository settings or use another repository.";
  }
  return message.length > 0 ? message : fallback;
}
