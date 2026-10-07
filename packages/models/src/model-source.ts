import type { ModelSource } from "@ace/protocol";

const labels: Readonly<Record<string, string>> = {
  "opencode-go": "OpenCode Go",
  opencode: "OpenCode Zen",
  "opencode-zen": "OpenCode Zen",
  "github-copilot": "GitHub Copilot",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  "llama.cpp": "llama.cpp",
};
export function providerSource(
  id: string,
  info: {
    name?: string | undefined;
    local?: boolean | undefined;
    baseURL?: string | undefined;
    types?: readonly string[] | undefined;
    authType?: string | undefined;
  } = {},
): ModelSource {
  let localhost = false;
  if (info.baseURL) {
    try {
      localhost = /^(?:localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)$/.test(
        new URL(info.baseURL).hostname,
      );
    } catch {
      /* Unknown endpoints stay unclassified. */
    }
  }
  const types = info.types ?? [];
  const kind =
    info.local ||
    localhost ||
    types.includes("local") ||
    (!info.baseURL && ["ollama", "lmstudio", "llama.cpp"].includes(id))
      ? "local"
      : ["opencode-go", "github-copilot"].includes(id) ||
          info.authType === "oauth" ||
          types.includes("oauth")
        ? "subscription"
        : ["opencode", "opencode-zen"].includes(id) ||
            info.authType === "api_key" ||
            types.includes("env") ||
            types.includes("api_key")
          ? "api_key"
          : "other";
  return {
    kind,
    id,
    label: info.name ?? labels[id] ?? id,
    ...(id === "opencode-go"
      ? { service: "opencode_go" }
      : ["opencode", "opencode-zen"].includes(id)
        ? { service: "opencode_zen" }
        : {}),
  };
}
