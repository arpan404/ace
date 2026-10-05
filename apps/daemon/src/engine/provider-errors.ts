import { z } from "zod";
import type { AgentError, Fact } from "@ace/core";
import type { ProviderKind, ProviderErrorDetails } from "@ace/protocol";

const metadata = z.object({ model: z.string().min(1).max(256).optional() }).passthrough();
const names: Record<ProviderKind, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
  opencode: "OpenCode",
  cursor: "Cursor",
  antigravity: "Antigravity",
  acp: "The provider",
};
/** Provider codes are authoritative only in notices/errors, never in assistant prose. */
function readable(
  provider: ProviderKind,
  text: string,
  selectedModel?: string,
): { text: string; details: ProviderErrorDetails } | undefined {
  const tag = /^\[[a-z0-9-]+:([a-z_]+)\]\s*(.*)$/s.exec(text.trim());
  const code = tag?.[1] ?? text.trim();
  let model = selectedModel;
  if (tag?.[2] && tag[2].length <= 8192) {
    try {
      const parsed = metadata.safeParse(JSON.parse(tag[2]));
      if (parsed.success && parsed.data.model) model = parsed.data.model;
    } catch {
      /* Native text is retained in raw, even if its metadata is malformed. */
    }
  }
  const name = names[provider];
  const messages: Record<string, string> = {
    unrecognized_model: `${name} could not use the selected model${model ? ` "${model}"` : ""}. Choose an available model or check this account's model access.`,
    model_not_found: `${name} could not use the selected model${model ? ` "${model}"` : ""}. Choose an available model or check this account's model access.`,
    authentication_failed: `${name} could not authenticate. Sign in again using the provider's own CLI.`,
    billing_error: `${name} stopped because this account has a billing issue. Check the account in the provider's CLI or dashboard.`,
    rate_limit: `${name} reached an account limit. Wait for the limit to reset or select another eligible account.`,
    overloaded_error: `${name} is temporarily overloaded. Try again shortly.`,
  };
  const message = Object.hasOwn(messages, code) ? messages[code] : undefined;
  return message
    ? { text: message, details: { code, provider, ...(model ? { model } : {}) } }
    : undefined;
}
export function structuredError(
  error: AgentError,
  provider: ProviderKind,
  selectedModel?: string,
): AgentError {
  const readableError = readable(
    provider,
    error.details?.code ?? error.code ?? error.message,
    error.details?.model ?? selectedModel,
  );
  if (readableError)
    error = {
      ...error,
      message: readableError.text,
      details: readableError.details,
      detail: error.detail ?? error.message,
    };
  const code = error.code ?? error.details?.code ?? error.kind;
  const title =
    error.title ??
    (code === "auth" || code === "authentication_failed"
      ? `Not signed in to ${provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : provider}`
      : code === "quota" || code === "rate_limit" || code === "billing_error"
        ? "Usage limit reached"
        : code === "network"
          ? "Network trouble"
          : code === "process_exit"
            ? "Agent process exited"
            : code === "context_length"
              ? "Conversation is too long"
              : code === "model_not_found" || code === "unrecognized_model"
                ? "Model not recognised"
                : "Turn failed");
  return { ...error, code, title, detail: error.detail ?? error.message };
}
/** Normalize provider failures once, retaining native evidence and both notice contracts. */
export function shapeProviderError(
  fact: Fact,
  provider: ProviderKind,
  selectedModel?: string,
): Fact {
  if (fact.type === "turn.ended" && fact.error)
    return { ...fact, error: structuredError(fact.error, provider, selectedModel) };
  if (
    (fact.type === "item.upsert" || fact.type === "item.reconciled") &&
    fact.draft.type === "notice"
  ) {
    const nativeText = fact.draft.text ?? "Turn failed";
    const translated = readable(
      provider,
      fact.draft.details?.code ?? fact.draft.code ?? nativeText,
      fact.draft.details?.model ?? selectedModel,
    );
    if (fact.draft.level !== "error" && !translated) return fact;
    const error = structuredError(
      {
        kind: "provider",
        message: translated?.text ?? nativeText,
        code: fact.draft.code ?? translated?.details.code,
        title: fact.draft.title,
        detail: fact.draft.detail ?? nativeText,
        details: translated?.details ?? fact.draft.details,
      },
      provider,
      selectedModel,
    );
    return {
      ...fact,
      draft: {
        ...fact.draft,
        text: error.message,
        code: error.code,
        title: error.title,
        detail: error.detail,
        details: error.details,
        ...(translated && !fact.draft.raw?.length
          ? { raw: [{ type: "provider.error", data: { text: nativeText } }] }
          : {}),
      },
    };
  }
  if (fact.type === "process.exited" && fact.message) {
    const error = readable(provider, fact.message, selectedModel);
    if (error) return { ...fact, message: error.text };
  }
  return fact;
}
