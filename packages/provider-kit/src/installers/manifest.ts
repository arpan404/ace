import { scriptExecutablePaths } from "./locations.ts";
import type { InstallAgent, ProviderKind } from "@ace/protocol";
export interface Installer {
  binary: string;
  sourceUrl: string;
  package?: string;
  npmFlags?: readonly string[];
  bun?: true;
  brew?: { name: string; cask?: true };
  script?: string;
  scriptHome?: string;
  scriptUninstall?: readonly (readonly ["-f" | "-rf", string])[];
  manual?: string;
}
/** Reviewed allowlist. Never derive commands or packages from registry/client payloads. */
export const installers: Readonly<Record<Exclude<ProviderKind, "acp">, Installer>> = {
  codex: {
    binary: "codex",
    package: "@openai/codex",
    sourceUrl: "https://learn.chatgpt.com/docs/codex/cli",
    brew: { name: "codex", cask: true },
    script: "https://chatgpt.com/codex/install.sh",
    scriptHome: scriptExecutablePaths.codex,
  },
  claude: {
    binary: "claude",
    package: "@anthropic-ai/claude-code",
    sourceUrl: "https://code.claude.com/docs/en/setup",
    brew: { name: "claude-code", cask: true },
    script: "https://claude.ai/install.sh",
    scriptHome: scriptExecutablePaths.claude,
    scriptUninstall: [
      ["-f", ".local/bin/claude"],
      ["-rf", ".local/share/claude"],
    ],
  },
  opencode: {
    binary: "opencode",
    package: "@opencode/cli",
    bun: true,
    sourceUrl: "https://opencode.ai/v2/docs/",
    brew: { name: "anomalyco/tap/opencode-v2" },
    script: "https://opencode.ai/v2/install",
    scriptHome: scriptExecutablePaths.opencode,
  },
  pi: {
    binary: "pi",
    package: "@earendil-works/pi-coding-agent",
    npmFlags: ["--ignore-scripts"],
    sourceUrl: "https://github.com/earendil-works/pi/tree/main/packages/coding-agent",
  },
  cursor: {
    binary: "",
    sourceUrl: "https://cursor.com/docs/sdk/typescript",
    manual: "Cursor's SDK ships with ace. Sign in to Cursor; update the SDK by updating ace.",
  },
  antigravity: {
    binary: "agy-acp",
    sourceUrl:
      "https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json",
    manual:
      "Download the Antigravity ACP server for your computer from the official registry. Extract the archive with its companion files, then set CLI path to the server executable and check again.",
  },
};
export const acpInstallers: Readonly<Record<InstallAgent, Installer>> = {
  gemini: {
    binary: "gemini",
    package: "@google/gemini-cli",
    brew: { name: "gemini-cli" },
    sourceUrl: "https://geminicli.com/docs/get-started/installation/",
  },
  "qwen-code": {
    binary: "qwen",
    package: "@qwen-code/qwen-code",
    sourceUrl: "https://qwenlm.github.io/qwen-code-docs/en/developers/development/deployment/",
  },
  "claude-acp": {
    binary: "claude-agent-acp",
    package: "@agentclientprotocol/claude-agent-acp",
    sourceUrl: "https://github.com/agentclientprotocol/claude-agent-acp/blob/main/README.md",
  },
  "codex-acp": {
    binary: "codex-acp",
    package: "@zed-industries/codex-acp",
    sourceUrl: "https://github.com/zed-industries/codex-acp/blob/main/README.md",
  },
  goose: {
    binary: "goose",
    brew: { name: "block-goose-cli" },
    sourceUrl: "https://formulae.brew.sh/formula/block-goose-cli",
  },
  auggie: {
    binary: "auggie",
    package: "@augmentcode/auggie",
    sourceUrl: "https://www.augmentcode.com/product/cli",
  },
};
export function installer(provider: ProviderKind, agent?: InstallAgent): Installer | undefined {
  return provider === "acp"
    ? agent && acpInstallers[agent]
    : agent
      ? undefined
      : installers[provider];
}
export const packageManagerSources = {
  npm: "https://docs.npmjs.com/cli/v11/commands/npm-uninstall/",
  bun: "https://bun.sh/docs/pm/cli/remove",
  brew: "https://docs.brew.sh/Manpage",
};
