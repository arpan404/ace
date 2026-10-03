import { nativeIdentity, object, string } from "./contracts.ts";

/** Stream only the SDK's supported root/one-level child deltas, preserving call identity. */
export async function streamText(
  body: unknown,
  emit: (kind: string, body: unknown) => Promise<void>,
  scrub: (text: string) => Iterable<string>,
  frameBytes: number,
): Promise<"root" | "child" | undefined> {
  const outer = object(body),
    nested = outer.type === "tool-call-delta";
  const update = nested ? object(outer.taskUpdate) : outer;
  const callId = nested ? nativeIdentity(outer.callId) : undefined;
  if (nested && !callId) return;
  const text = string(update.text);
  if (!["text-delta", "thinking-delta"].includes(string(update.type) ?? "") || !text) return;
  const chars = Math.max(128, Math.floor((frameBytes - 2048) / 6));
  for (const piece of scrub(text))
    for (let offset = 0; offset < piece.length;) {
      let end = Math.min(piece.length, offset + chars);
      const high = piece.charCodeAt(end - 1),
        low = piece.charCodeAt(end);
      if (end < piece.length && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff)
        end++;
      const delta = { type: update.type, text: piece.slice(offset, end) };
      await emit("delta-chunk", nested ? { type: outer.type, callId, taskUpdate: delta } : delta);
      offset = end;
    }
  return nested ? "child" : "root";
}

export function markText(body: unknown, streamed: "root" | "child" | undefined): unknown {
  const preview = object(body);
  if (streamed === "child")
    return { ...preview, taskUpdate: { ...object(preview.taskUpdate), aceTextStream: true } };
  return streamed === "root" ? { ...preview, aceTextStream: true } : body;
}
