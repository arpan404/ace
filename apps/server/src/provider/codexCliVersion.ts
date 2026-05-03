import {
  compareCliVersions,
  formatCliUpgradeMessage,
  isCliVersionAtLeast,
  normalizeParsedCliVersion,
} from "./cliVersionRequirement";

const CODEX_VERSION_PATTERN = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/;

export const MINIMUM_CODEX_CLI_VERSION = "0.37.0";

export function compareCodexCliVersions(left: string, right: string): number {
  return compareCliVersions(left, right);
}

export function parseCodexCliVersion(output: string): string | null {
  const match = CODEX_VERSION_PATTERN.exec(output);
  if (!match?.[1]) {
    return null;
  }

  return normalizeParsedCliVersion(match[1]);
}

export function isCodexCliVersionSupported(version: string): boolean {
  return isCliVersionAtLeast(version, MINIMUM_CODEX_CLI_VERSION);
}

export function formatCodexCliUpgradeMessage(version: string | null): string {
  return formatCliUpgradeMessage({
    providerLabel: "Codex",
    version,
    minimumVersion: MINIMUM_CODEX_CLI_VERSION,
  });
}
