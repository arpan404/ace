import { object, string } from "./contracts.ts";

/*
 * A cut-off run's messages, read back from the SDK store after a restart (ADR 0043, amendment of
 * 2026-11-22), turned back into the onDelta updates they were stored from, so the live
 * translation renders them exactly as it would have: text, thinking, tool calls with their
 * results (a shell's output included), task summaries. Pure.
 *
 * What SDK 1.0.35 does not store, and so never comes back:
 * - a subagent's own steps: only its task call and result are stored;
 * - output a tool's stored copy shortened: the SDK marks those `truncated`.
 * Shell output streamed live is not stored either, but the completed call's result carries it.
 */

/** The SDK's stored tool status, as the update it came from. */
function toolUpdate(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const callId = string(body.call_id);
  if (!callId) return undefined;
  const toolCall = {
    type: string(body.name) ?? "unknown",
    ...("args" in body ? { args: body.args } : {}),
    ...("result" in body ? { result: body.result } : {}),
  };
  return {
    type: body.status === "running" ? "tool-call-started" : "tool-call-completed",
    callId,
    toolCall,
  };
}

/** The update a stored SDK message came from; none for bookkeeping (request, status, user). */
export function storedUpdate(message: unknown): Record<string, unknown> | undefined {
  const body = object(message);
  switch (body.type) {
    case "assistant": {
      const content = object(body.message).content;
      const text = (Array.isArray(content) ? content : [])
        .map((part) => (object(part).type === "text" ? (string(object(part).text) ?? "") : ""))
        .join("");
      return text ? { type: "text-delta", text } : undefined;
    }
    case "thinking": {
      const text = string(body.text) ?? "";
      return text
        ? { type: "thinking-delta", text }
        : {
            type: "thinking-completed",
            ...(typeof body.thinking_duration_ms === "number"
              ? { thinkingDurationMs: body.thinking_duration_ms }
              : {}),
          };
    }
    case "tool_call":
      return toolUpdate(body);
    case "task":
      return string(body.text) ? { type: "summary", summary: string(body.text) } : undefined;
    default:
      return undefined;
  }
}

/** Why some of a recovered tail is not in the SDK's store, in plain words. */
export function storeGap(message: unknown): string | undefined {
  const body = object(message);
  if (body.type !== "tool_call" || body.status === "running") return undefined;
  const truncated = object(body.truncated);
  if (truncated.args === true || truncated.result === true)
    return "Cursor's saved session kept only a shortened copy of some tool input or output from that time.";
  if (string(body.name) === "task")
    return "What a subagent did step by step in that time is not in Cursor's saved session; only its result is.";
  return undefined;
}
