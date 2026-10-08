/** Official per-user script destinations, shared by discovery and the reviewed manifest. */
export const scriptExecutablePaths = {
  codex: ".local/bin/codex",
  claude: ".local/bin/claude",
  opencode: ".opencode/bin/opencode",
} as const;
