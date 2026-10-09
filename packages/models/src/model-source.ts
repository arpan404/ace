import type { ModelSource } from "@ace/protocol";

import { serviceLabel } from "./service-labels.ts";

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
      : ["opencode-go", "github-copilot", "openai-codex", "openai-chatgpt"].includes(id) ||
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
    label: serviceLabel(id) !== id ? serviceLabel(id) : (info.name ?? id),
    ...(id === "opencode-go"
      ? { service: "opencode_go" }
      : ["opencode", "opencode-zen"].includes(id)
        ? { service: "opencode_zen" }
        : {}),
  };
}

/** Ollama's cloud suffix is model-specific, even when served through a local endpoint. */
export function modelSource(id: string, modelId: string, source = providerSource(id)): ModelSource {
  const label = serviceLabel(source.id);
  const named =
    source.kind !== "account" && label !== source.id
      ? {
          ...source,
          label,
          ...(["openai-codex", "openai-chatgpt"].includes(source.id)
            ? { kind: "subscription" as const }
            : {}),
        }
      : source;
  return id === "ollama" && /(?::cloud|-cloud)$/i.test(modelId)
    ? {
        ...named,
        id: "ollama-cloud",
        kind: "api_key",
        requiresAuth: true,
        label: serviceLabel("ollama-cloud"),
      }
    : named;
}
