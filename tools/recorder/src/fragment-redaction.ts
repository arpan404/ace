import { z } from "zod";
import { createRedactor, type RedactionContext } from "./redact.ts";

type Slot = { key: string; text: string; set(text: string): void };
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
type Pending = { value: unknown; slots: Slot[] };
const Text = z.object({ text: z.string() });
const boundary = /[\s"'`<>]/;

const object = (value: unknown): Record<string, unknown> | undefined =>
  isObject(value) ? value : undefined;

const stream = (value: unknown): string => {
  const root = object(value),
    data = object(root?.data),
    body = object(data?.body);
  return JSON.stringify([
    root?.threadId,
    root?.dir,
    root?.channel,
    data?.operationId,
    data?.agentId,
    data?.runId,
    data?.kind,
    body?.type,
  ]);
};

/** Buffer at most 32 records / 256 KiB, joining only matching text streams.
 * A boundary or close flushes the window. Overflow omits an unfinished path
 * and its continuation rather than publishing a private path prefix. */
export function createRecordingRedactor(context: RedactionContext, fields: readonly string[] = []) {
  const scrub = createRedactor(context, fields);
  const literal = new Set(["text", "delta", ...fields]);
  let pending: Pending[] = [];
  let bytes = 0;
  const dropping = new Set<string>();
  function slots(value: unknown): Slot[] {
    const result: Slot[] = [];
    const identity = stream(value);
    let remaining = 10000;
    function visit(input: unknown, path: string, depth: number): void {
      if (--remaining < 0 || depth > 32) return;
      if (Array.isArray(input)) {
        input
          .slice(0, remaining)
          .forEach((item, index) => visit(item, `${path}/${index}`, depth + 1));
        return;
      }
      const record = object(input);
      if (!record) return;
      for (const [key, item] of Object.entries(record)) {
        const location = `${path}/${key}`;
        if (typeof item === "string" && literal.has(key)) {
          result.push({
            key: `${identity}:${location}`,
            text: item,
            set(text) {
              record[key] = text;
            },
          });
        } else visit(item, location, depth + 1);
      }
    }
    visit(value, "", 0);
    return result;
  }
  function flush(): string[] {
    const groups = new Map<string, Slot[]>();
    for (const record of pending)
      for (const slot of record.slots) {
        const group = groups.get(slot.key) ?? [];
        group.push(slot);
        groups.set(slot.key, group);
      }
    for (const [key, group] of groups) {
      let text = group.map((slot) => slot.text).join("");
      // An incomplete path at the end of a bounded window must not leak.
      const tail = /[^\s"'`<>]*$/.exec(text)?.[0] ?? "";
      if (tail.startsWith("/") || tail.startsWith("\\")) {
        text = text.slice(0, text.length - tail.length) + "<FRAGMENT OMITTED>";
        if (!dropping.has(key) && dropping.size >= 64)
          throw new Error("Fragment redaction stream budget exceeded");
        dropping.add(key);
      }
      const safe = Text.parse(JSON.parse(scrub(JSON.stringify({ text })))).text;
      let offset = 0;
      for (let index = 0; index < group.length; index++) {
        const slot = group[index];
        if (!slot) continue;
        const end =
          index === group.length - 1
            ? safe.length
            : Math.min(safe.length, offset + slot.text.length);
        slot.set(safe.slice(offset, end));
        offset = end;
      }
    }
    const output = pending.map((record) => scrub(JSON.stringify(record.value)));
    pending = [];
    bytes = 0;
    return output;
  }
  return {
    push(line: string): string[] {
      const size = Buffer.byteLength(line);
      if (size > 262144) return [...flush(), scrub(line)];
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return [...flush(), scrub(line)];
      }
      const textSlots = slots(value);
      if (!textSlots.length && !pending.length) return [scrub(line)];
      const output: string[] = [];
      if (pending.length >= 32 || bytes + size > 262144) output.push(...flush());
      for (const slot of textSlots)
        if (dropping.has(slot.key)) {
          const end = slot.text.search(boundary);
          if (end < 0) slot.text = "";
          else {
            slot.text = slot.text.slice(end);
            dropping.delete(slot.key);
          }
          slot.set(slot.text);
        }
      pending.push({ value, slots: textSlots });
      bytes += size;
      if (
        textSlots.length &&
        textSlots.every((slot) => slot.text === "" || boundary.test(slot.text.at(-1) ?? ""))
      )
        output.push(...flush());
      return output;
    },
    finish(): string[] {
      const output = flush();
      dropping.clear();
      return output;
    },
  };
}
