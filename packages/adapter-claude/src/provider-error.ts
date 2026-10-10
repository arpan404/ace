import { z } from "zod";
import type { AgentError } from "@ace/core";
const metadata = z.object({ model: z.string().optional() });
export function claudeError(code: string, text: string, model?: string): AgentError {
  let reportedModel = model;
  const json = text.slice(text.indexOf("{") < 0 ? text.length : text.indexOf("{"));
  try {
    const parsed = metadata.safeParse(JSON.parse(json));
    if (parsed.success) reportedModel = parsed.data.model ?? model;
  } catch {
    /* Raw text remains available in detail. */
  }
  if (code === "unrecognized_model" || code === "model_not_found") {
    const title = `Claude Code doesn't recognise the model${reportedModel ? ` "${reportedModel}"` : ""}`;
    return { kind: "provider", code: "model_not_found", title, message: title, detail: text };
  }
  const kind =
    code === "authentication_failed" || code === "auth"
      ? "auth"
      : code === "billing_error" || code === "rate_limit" || code === "quota"
        ? "quota"
        : code === "network"
          ? "network"
          : "provider";
  const title =
    kind === "auth"
      ? "Not signed in to Claude Code"
      : kind === "quota"
        ? "Usage limit reached"
        : kind === "network"
          ? "Network trouble"
          : code === "context_length"
            ? "Conversation is too long"
            : code === "overloaded_error" || /(?:API Error: 529|overloaded)/i.test(text)
              ? "Claude is busy. Try again shortly."
              : code === "server_error" || /API Error: 5\d\d/.test(text)
                ? "Claude had a server error. Try again shortly."
                : code === "max_output_tokens" || code === "output_limit"
                  ? "Claude reached its response limit. Ask it to continue."
                  : "Claude Code execution failed. Try again.";
  return {
    kind,
    code: kind === "auth" ? "auth" : code === "billing_error" ? "quota" : code,
    title,
    message: title,
    detail: text,
  };
}
