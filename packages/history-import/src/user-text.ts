import { object, string } from "@ace/native-session";

import { sanitizeUserText } from "@ace/native-session";
export { sanitizeUserText } from "@ace/native-session";

export function sessionTitle(preferred: string, prompt: string, at: number): string {
  const clean = sanitizeUserText(preferred)
    .replace(/<[^>]*(?:>|$)/g, "")
    .trim();
  const title =
    clean && !/^(?:untitled(?: session)?|new session(?: - .*)?)$/i.test(clean)
      ? clean
      : sanitizeUserText(prompt)
          .replace(/<[^>]*(?:>|$)/g, "")
          .trim();
  return (
    title.replace(/\s+/g, " ").slice(0, 256) ||
    `Session from ${new Date(at).toISOString().slice(0, 10)}`
  );
}

/** Native message text, independent of transport and provider storage. */
export function userPrompt(value: unknown): string {
  const r = object(value);
  const p = r.type === "response_item" ? object(r.payload) : r;
  const message = Object.hasOwn(p, "message") ? object(p.message) : p;
  if (message.role !== "user" && p.type !== "user") return "";
  if (p.synthetic === true || p.isMeta === true) return "";
  const content = message.content ?? p.content ?? p.text;
  return sanitizeUserText(
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => string(object(part).text) ?? "").join("\n")
        : "",
  );
}

/** A deliberate attachment is user input even when it has no caption. */
export function hasUserInput(value: unknown): boolean {
  if (userPrompt(value)) return true;
  const r = object(value);
  const p = r.type === "response_item" ? object(r.payload) : r;
  const m = Object.hasOwn(p, "message") ? object(p.message) : p;
  if ((m.role !== "user" && p.type !== "user") || p.synthetic === true || p.isMeta === true)
    return false;
  const content = m.content ?? p.content;
  return (
    Array.isArray(content) &&
    content.some((part) => ["image", "input_image", "file"].includes(String(object(part).type)))
  );
}
