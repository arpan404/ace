import type { Fact, Key } from "@ace/core";
import { obj, str, list } from "./native.ts";
import { z } from "zod";
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageCounts = z.object({
  input: count,
  output: count,
  cacheRead: count.default(0),
  cacheWrite: count.default(0),
});
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
    const u = obj(m.usage),
      cost = obj(u.cost);
    const counts = usageCounts.safeParse(u).data;
    const model =
      typeof m.provider === "string" && typeof m.model === "string"
        ? `${m.provider}/${m.model}`
        : undefined;
    if (counts && Number.isSafeInteger(counts.input + counts.cacheRead + counts.cacheWrite))
      facts.push({
        type: "usage",
        agent,
        inputTokens: counts.input + counts.cacheRead + counts.cacheWrite,
        outputTokens: counts.output,
        cachedInputTokens: counts.cacheRead,
        cacheWriteTokens: counts.cacheWrite,
        counterMode: "incremental",
        ...(typeof m.timestamp === "number" && Number.isSafeInteger(m.timestamp)
          ? { counterKey: `pi:message:${m.timestamp}` }
          : {}),
        ...(model ? { model } : {}),
        ...(m.provider === "openrouter" ? { billingMode: "api" } : {}),
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
        parts:
          typeof m.content === "string"
            ? [{ type: "text", text: m.content }]
            : list(m.content)
                .filter((block) => obj(block).type === "text")
                .map((block) => ({ type: "text", text: str(obj(block).text) })),
        raw: raw(input.data),
      },
    });
  return { facts };
}
