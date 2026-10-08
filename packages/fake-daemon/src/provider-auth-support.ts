import type { ProviderKind } from "@ace/protocol";
export function fakeApiKeySupport(provider: ProviderKind) {
  return ["codex", "cursor", "opencode"].includes(provider)
    ? {
        supported: true,
        ...(provider === "opencode"
          ? { upstreams: ["openai", "anthropic", "openrouter", "opencode"] }
          : {}),
      }
    : { supported: false, reason: "The CLI has no reviewed stdin key-storage command." };
}
