import type { Fact, Key } from "@ace/core";
import { obj, str, list } from "./native.ts";
import { resultText } from "./tools.ts";
export type MessageOutcome = "completed" | "failed" | "interrupted";
const raw = (data: unknown) => [{ type: str(obj(data).type) || "message_end", data }];
/** Each admitted envelope is retained once; subsequent items retain only their native block. */
export function messageFacts(input: {
  agent: Key;
  prefix: string;
  message: number;
  streamed: ReadonlySet<number>;
  data: unknown;
}): { facts: Fact[]; outcome?: MessageOutcome } | undefined {
  const e = obj(input.data),
    m = obj(e.message),
    facts: Fact[] = [];
  if (Array.isArray(m.content) && m.content.length > 256) return undefined;
  const { agent, prefix, message, streamed } = input;
  if (m.role === "assistant") {
    let retained = false;
    list(m.content).forEach((block, index) => {
      const b = obj(block);
      if (b.type !== "text" && b.type !== "thinking") return;
      const native = raw(retained ? block : input.data);
      retained = true;
      facts.push({
        type: "item.upsert",
        agent,
        item: `${prefix}:message:${message}:${index}`,
        draft:
          b.type === "text"
            ? {
                type: "message",
                role: "assistant",
                complete: true,
                ...(!streamed.has(index) ? { parts: [{ type: "text", text: str(b.text) }] } : {}),
                raw: native,
              }
            : {
                type: "reasoning",
                complete: true,
                ...(!streamed.has(index) ? { text: str(b.thinking) } : {}),
                raw: native,
              },
      });
    });
    if (!retained)
      facts.push({
        type: "item.upsert",
        agent,
        item: `${prefix}:message:${message}:native`,
        draft: {
          type: "notice",
          level: "info",
          complete: true,
          text: "Pi final message",
          raw: raw(input.data),
        },
      });
    const u = obj(m.usage),
      cost = obj(u.cost);
    if (typeof u.input === "number" && typeof u.output === "number")
      facts.push({
        type: "usage",
        agent,
        inputTokens: u.input,
        outputTokens: u.output,
        ...(typeof u.cacheRead === "number" ? { cachedInputTokens: u.cacheRead } : {}),
        ...(typeof cost.total === "number" ? { costUsd: cost.total } : {}),
      });
    const reason = str(m.stopReason);
    return {
      facts,
      ...(["stop", "length", "error", "aborted"].includes(reason)
        ? {
            outcome:
              reason === "error" ? "failed" : reason === "aborted" ? "interrupted" : "completed",
          }
        : {}),
    };
  }
  if (m.role === "user")
    facts.push({
      type: "item.upsert",
      agent,
      item: `${prefix}:user:${message}`,
      draft: {
        type: "message",
        role: "user",
        complete: true,
        parts: [{ type: "text", text: typeof m.content === "string" ? m.content : resultText(m) }],
        raw: raw(input.data),
      },
    });
  return { facts };
}
