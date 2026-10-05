import { z } from "zod";
import type { Fact } from "@ace/core";
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
export function readableProviderFact(
  provider: ProviderKind,
  fact: Fact,
  selectedModel?: string,
): Fact {
  if (
    (fact.type === "item.upsert" || fact.type === "item.reconciled") &&
    fact.draft.type === "notice" &&
    fact.draft.text
  ) {
    const error = readable(provider, fact.draft.text, selectedModel);
    if (error)
      return {
        ...fact,
        draft: {
          ...fact.draft,
          text: error.text,
          details: error.details,
          raw: fact.draft.raw?.length
            ? fact.draft.raw
            : [{ type: "provider.error", data: { text: fact.draft.text } }],
        },
      };
  }
  if (fact.type === "turn.ended" && fact.error) {
    const error = readable(
      provider,
      fact.error.details?.code ?? fact.error.message,
      fact.error.details?.model ?? selectedModel,
    );
    if (error)
      return { ...fact, error: { ...fact.error, message: error.text, details: error.details } };
  }
  if (fact.type === "process.exited" && fact.message) {
    const error = readable(provider, fact.message, selectedModel);
    if (error) return { ...fact, message: error.text };
  }
  return fact;
}
