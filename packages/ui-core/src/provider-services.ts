export { serviceLabel } from "@ace/models/service-labels";
import { serviceLabel } from "@ace/models/service-labels";
import { providerNames } from "./providers.ts";
import type { ModelSource, ProviderKind } from "@ace/protocol";
import type { Brand } from "./brand-art/index.gen.ts";

/*
 * The services OpenCode and Pi reach models through (OpenCode Go, GitHub Copilot, the person's
 * API-key providers), as people know them: the mark that stands for each and a line that says
 * what connecting it means. Ids are the CLIs' own (`opencode auth login` choices, catalog source
 * ids). A service not listed here still works; it just shows its initial and no description.
 */

export interface ServiceInfo {
  /** The maker's mark, when we have one; never a lookalike. */
  brand?: Brand | undefined;
  /** "Use your GitHub Copilot plan": one short line for the sign-in choices. */
  description?: string | undefined;
}

const services: Record<string, ServiceInfo> = {
  "github-copilot": { brand: "githubcopilot", description: "Use your GitHub Copilot plan" },
  copilot: { brand: "githubcopilot", description: "Use your GitHub Copilot plan" },
  openai: { brand: "openai", description: "ChatGPT plan or OpenAI API key" },
  anthropic: { brand: "claude", description: "Claude plan or Anthropic API key" },
  "opencode-go": { brand: "opencode", description: "OpenCode's own subscription" },
  opencode: { brand: "opencode", description: "Pay-as-you-go models from OpenCode" },
  "opencode-zen": { brand: "opencode", description: "Pay-as-you-go models from OpenCode" },
  "openai-codex": { brand: "openai", description: "Use your ChatGPT plan" },
  "openai-chatgpt": { brand: "openai", description: "Use your ChatGPT plan" },
  "google-gemini-cli": { brand: "geminicli", description: "Use your Google account" },
  "google-antigravity": { brand: "antigravity", description: "Use your Google account" },
  antigravity: { brand: "antigravity" },
  claude: { brand: "claude" },
  openrouter: { brand: "openrouter", description: "Many providers through one API key" },
  google: { brand: "gemini", description: "Gemini API key" },
  gemini: { brand: "gemini", description: "Gemini API key" },
  deepseek: { brand: "deepseek", description: "DeepSeek API key" },
  mistral: { brand: "mistral", description: "Mistral API key" },
  xai: { brand: "grok", description: "Grok API key" },
  moonshot: { brand: "kimi", description: "Kimi API key" },
  moonshotai: { brand: "kimi", description: "Kimi API key" },
  "minimax-cn": { brand: "minimax", description: "MiniMax API key" },
  "google-vertex": { brand: "gemini", description: "Gemini through Google Cloud" },
  zai: { brand: "zai", description: "GLM API key" },
  minimax: { brand: "minimax", description: "MiniMax API key" },
  qwen: { brand: "qwen" },
};

/** What ace knows about a service by its id; empty for one it doesn't. */
export function serviceInfo(id: string): ServiceInfo {
  return services[id.toLowerCase()] ?? {};
}

/** How a service is reached, in a word or two: "Subscription", "API key", "On this computer". */
export function serviceKind(kind: ModelSource["kind"]): string | undefined {
  switch (kind) {
    case "subscription":
      return "Subscription";
    case "api_key":
      return "API key";
    case "local":
      return "On this computer";
    case "account":
    case "other":
      return undefined;
  }
}

/** Name the service that owns an API key, even when another provider routes to it. */
export function apiKeyServiceLabel(provider: ProviderKind, upstream?: string): string {
  const label = upstream && serviceLabel(upstream);
  return label && label !== upstream
    ? label
    : provider === "codex"
      ? serviceLabel("openai")
      : providerNames[provider];
}
