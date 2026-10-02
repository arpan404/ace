import type { Item } from "@ace/protocol";

export const FIELD_CAP = 8192;
export const GAP = "\n[… omitted …]\n";
export interface TextWindow {
  head: string;
  tail: string;
  size: number;
}
export function appendWindow(window: TextWindow, text: string): TextWindow {
  const size = window.size + text.length;
  const head =
    window.size < FIELD_CAP
      ? (window.head + text.slice(0, FIELD_CAP)).slice(0, FIELD_CAP)
      : window.head;
  // Small documents store their text once. Tail allocation begins at overflow.
  const tail =
    size <= FIELD_CAP
      ? ""
      : text.length >= FIELD_CAP
        ? text.slice(-FIELD_CAP)
        : ((window.tail || window.head) + text).slice(-FIELD_CAP);
  return { head, tail, size };
}
export function windowText(window: TextWindow): string {
  if (window.size <= FIELD_CAP) return window.head;
  if (window.size <= FIELD_CAP * 2)
    return window.head + window.tail.slice(window.head.length + window.tail.length - window.size);
  return window.head + GAP + window.tail;
}

export function capText(text: string): string {
  return windowText(appendWindow({ head: "", tail: "", size: 0 }, text));
}
/** Bounded traversal of typed fields; raw/native data is never passed here. */
export function itemText(item: Item): { title: string; window: TextWindow } {
  let window: TextWindow = { head: "", tail: "", size: 0 };
  let remaining = 256;
  const add = (value: unknown, depth = 0): void => {
    if (--remaining < 0 || depth > 8) return;
    if (typeof value === "string") {
      if (window.size) window = appendWindow(window, "\n");
      window = appendWindow(window, value);
    } else if (typeof value === "number" || typeof value === "boolean")
      add(String(value), depth + 1);
    else if (Array.isArray(value)) {
      for (const entry of value.slice(0, 64)) add(entry, depth + 1);
      if (value.length > 64) for (const entry of value.slice(-64)) add(entry, depth + 1);
    } else if (value !== null && typeof value === "object") {
      // Enumerating keys may be unbounded: consume only the first 64 own entries.
      let count = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (++count > 64) break;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && "value" in descriptor) add(descriptor.value, depth + 1);
      }
    }
  };
  switch (item.type) {
    case "message":
      for (const part of [
        ...item.parts.slice(0, 64),
        ...(item.parts.length > 64 ? item.parts.slice(-64) : []),
      ]) {
        if (part.type === "text") add(part.text);
        else if (part.type === "file") add(part.path);
      }
      break;
    case "reasoning":
    case "notice":
      add(item.text);
      break;
    case "tool_call":
      add(item.call.detail);
      add(item.call.error);
      break;
    case "compaction":
      break;
  }
  return { title: item.type === "tool_call" ? capText(item.call.title) : "", window };
}

/** Quotes every literal; operators, column filters and quotes have no syntax power. */
export function matchExpression(
  text: string,
  mode: "tokens" | "substring",
  scope: "items" | "threads",
): string {
  if (mode === "substring") {
    if ([...text].length < 3) throw new Error("search_invalid_query");
    return `"${text.replaceAll('"', '""')}"`;
  }
  const terms = text.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [];
  if (!terms.length || terms.length > 64) throw new Error("search_invalid_query");
  return terms.map((term) => `"${term}"${scope === "threads" ? "*" : ""}`).join(" AND ");
}
