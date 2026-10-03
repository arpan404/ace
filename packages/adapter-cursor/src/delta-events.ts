import type { Fact, Key } from "@ace/core";
import { object, string, nativeIdentity, type CursorEnvelope } from "./contracts.ts";
import type { Children } from "./children.ts";
import type { Transcript } from "./transcript.ts";
import type { ToolEvents } from "./tool-events.ts";
import { turnUsage } from "./usage.ts";
interface DeltaContext {
  children: Children;
  tools: ToolEvents;
  transcript: Transcript;
  current: CursorEnvelope | undefined;
  operation: string | undefined;
  segment: number;
  cwd: string;
  nextUsage(): number;
  notice(text: string, data: unknown, level?: "info" | "warning" | "error"): Fact;
}
/** Pure decoding for one-level SDK deltas; envelope/session decisions stay outside. */
export function translateDelta(
  body: Record<string, unknown>,
  agent: Key,
  namespace: string,
  context: DeltaContext,
  depth = 0,
): Fact[] {
  const type = string(body.type);
  if ((type === "text-delta" || type === "thinking-delta") && body.aceTextStream === true)
    return [
      context.notice(
        "Large SDK text retained in ordered chunks; original body is raw provenance",
        context.current,
      ),
    ];
  if (type === "text-delta" || type === "thinking-delta")
    return context.transcript.append(
      agent,
      type === "text-delta" ? "text" : "thinking",
      string(body.text) ?? "",
    );
  if (type === "step-started" || type === "step-completed" || type === "thinking-completed")
    return context.transcript.boundary(agent);
  if (type === "turn-ended")
    return turnUsage(body.usage, agent, `${namespace}:${agent}:usage:${context.nextUsage()}`);
  if (type === "tool-call-delta") {
    if (depth >= 1)
      return [
        context.notice(
          "Nested task deltas beyond one level are incomplete",
          context.current,
          "warning",
        ),
      ];
    const call = `${namespace}:call:${nativeIdentity(body.callId) ?? ""}`;
    const child = context.children.calls.get(call);
    if (!child)
      return [
        context.notice(
          "Nested update has no observed owning task call",
          context.current,
          "warning",
        ),
      ];
    const facts = translateDelta(object(body.taskUpdate), child.key, namespace, context, depth + 1);
    return facts.some((fact) => fact.type === "item.upsert" || fact.type === "item.delta")
      ? [...context.children.observe(call, context.cwd), ...facts]
      : facts;
  }
  if (["tool-call-started", "partial-tool-call", "tool-call-completed"].includes(type ?? ""))
    return context.tools.translate(
      body,
      agent,
      namespace,
      context.current,
      context.transcript,
      context.operation,
      context.segment,
      context.cwd,
      (text, data, level) => context.notice(text, data, level),
    );
  // Shell output events are opaque records; keep them rather than inventing call association.
  if (type === "shell-output-delta" && body.aceOutputStream === true) return [];
  if (type === "shell-output-delta")
    return [
      context.notice(
        "SDK shell output delta retained; call association unavailable",
        context.current,
      ),
    ];
  return [context.notice("Unknown SDK delta retained", context.current)];
}
