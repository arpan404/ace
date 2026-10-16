import type { ProviderKind } from "@ace/protocol";
export function fakeApiKeySupport(provider: ProviderKind) {
  return ["codex", "cursor"].includes(provider)
    ? { supported: true }
    : {
        supported: false,
        reason:
          provider === "opencode"
            ? "OpenCode v2 accepts keys in its own sign-in terminal. Choose Sign in to open it in ace."
            : "The CLI has no reviewed stdin key-storage command.",
      };
}
