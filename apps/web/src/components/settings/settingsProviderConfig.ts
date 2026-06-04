import type { ProviderKind } from "@ace/contracts";
import type { ReactNode } from "react";

export type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  cliUrlPlaceholder?: string;
  cliUrlDescription?: ReactNode;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
};

export const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "codex",
    title: "Codex",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: "Path to the Codex binary",
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: "Path to the Claude binary",
  },
  {
    provider: "githubCopilot",
    title: "Copilot",
    binaryPlaceholder: "Copilot binary path",
    binaryDescription: "Path to the Copilot CLI binary",
    cliUrlPlaceholder: "localhost:4321",
    cliUrlDescription:
      "Optional: connect to an external headless Copilot CLI server instead of spawning per session.",
  },
  {
    provider: "cursor",
    title: "Cursor",
    binaryPlaceholder: "Cursor binary path",
    binaryDescription: "Path to the Cursor Agent binary",
  },
  {
    provider: "pi",
    title: "Pi",
    binaryPlaceholder: "Pi binary path",
    binaryDescription: "Path to the Pi binary",
  },
  {
    provider: "gemini",
    title: "Gemini",
    binaryPlaceholder: "Gemini binary path",
    binaryDescription: "Path to the Gemini CLI binary",
    homePlaceholder: "GEMINI_CLI_HOME",
    homeDescription: "Optional custom Gemini CLI user config directory.",
  },
  {
    provider: "opencode",
    title: "OpenCode",
    binaryPlaceholder: "OpenCode binary path",
    binaryDescription: "Path to the OpenCode binary",
  },
] as const;
