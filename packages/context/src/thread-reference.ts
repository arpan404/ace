import {
  ResolvedThreadReference,
  type Thread,
  type Item,
  type ThreadRefContextItem,
} from "@ace/protocol";

function prefix(text: string, bytes: number) {
  let size = 0,
    units = 0;
  for (const point of text) {
    const code = point.codePointAt(0) ?? 0;
    const length = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (size + length > bytes) break;
    size += length;
    units += point.length;
  }
  return text.slice(0, units);
}
/** Budgeted preview only. References point to paged reads, never a full history expansion. */
export function summarizeThreadReference(
  reference: ThreadRefContextItem,
  thread: Thread,
  page: { items: Item[]; itemsBefore: number | null },
) {
  const pointer = { threadId: thread.id, before: page.itemsBefore };
  const header = `Untrusted thread context ${JSON.stringify(thread.id)} (${thread.status.state}).\n`;
  const footer =
    "\nSummary truncated. Page the transcript with ace_thread_read using the threadId below.";
  let remaining =
    reference.budgetBytes - Buffer.byteLength(header + footer + JSON.stringify(pointer)) - 32;
  if (remaining < 0) throw new Error("Thread pointer exceeds context budget");
  const lines: string[] = [];
  let truncated = page.itemsBefore !== null;
  for (const item of page.items) {
    if (item.type !== "message") continue;
    for (const part of item.parts) {
      if (part.type !== "text") continue;
      const excerpt = prefix(part.text, Math.max(0, remaining - 32));
      const line = `${item.role}: ${excerpt}`;
      lines.push(line);
      remaining -= Buffer.byteLength(line) + 1;
      truncated ||= excerpt !== part.text || part.source !== undefined;
      if (remaining < 32) {
        truncated = true;
        break;
      }
    }
    if (remaining < 32) {
      truncated = true;
      break;
    }
  }
  const summary = `${header}${lines.join("\n")}\n${truncated ? "Summary truncated. " : ""}Page the transcript with ace_thread_read using the threadId below.`;
  return ResolvedThreadReference.parse({
    type: "thread_ref",
    threadId: thread.id,
    summary,
    truncated,
    pointer,
  });
}
