import type { AgentError, Fact } from "@ace/core";
import type { ProviderKind } from "@ace/protocol";
export function structuredError(error: AgentError, provider: ProviderKind): AgentError {
  const code =
    error.code ?? error.kind;
  const title =
    error.title ??
    (code === "auth"
      ? `Not signed in to ${provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : provider}`
      : code === "quota" || code === "rate_limit"
        ? "Usage limit reached"
        : code === "network"
          ? "Network trouble"
          : code === "process_exit"
            ? "Agent process exited"
            : code === "context_length"
              ? "Conversation is too long"
              : code === "model_not_found"
                ? "Model not recognised"
                : "Turn failed");
  return { ...error, code, title, detail: error.detail ?? error.message };
}
/** Shape terminal facts at the daemon boundary without interpreting ordinary assistant prose. */
export function shapeProviderError(fact: Fact, provider: ProviderKind): Fact {
  if (fact.type === "turn.ended" && fact.error)
    return { ...fact, error: structuredError(fact.error, provider) };
  if (
    (fact.type === "item.upsert" || fact.type === "item.reconciled") &&
    fact.draft.type === "notice" &&
    fact.draft.level === "error"
  ) {
    const error = structuredError(
      {
        kind: "provider",
        message: fact.draft.text ?? "Turn failed",
        code: fact.draft.code,
        title: fact.draft.title,
        detail: fact.draft.detail,
      },
      provider,
    );
    return {
      ...fact,
      draft: { ...fact.draft, code: error.code, title: error.title, detail: error.detail },
    };
  }
  return fact;
}
