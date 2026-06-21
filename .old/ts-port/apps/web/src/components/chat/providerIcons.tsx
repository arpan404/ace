import type { ProviderKind } from "@ace/contracts";
import {
  ClaudeAI,
  CursorIcon,
  Gemini,
  GitHubIcon,
  type Icon,
  OpenAI,
  OpenCodeIcon,
  PiIcon,
} from "../Icons";

export const PROVIDER_ICON_BY_PROVIDER: Record<ProviderKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  githubCopilot: GitHubIcon,
  cursor: CursorIcon,
  pi: PiIcon,
  gemini: Gemini,
  opencode: OpenCodeIcon,
};

export function providerIconClassName(provider: ProviderKind, fallbackClassName: string): string {
  if (provider === "claudeAgent") {
    return "text-warning-foreground";
  }
  if (provider === "githubCopilot") {
    return "text-foreground";
  }
  return fallbackClassName;
}
