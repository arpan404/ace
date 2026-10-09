import { object, string } from "@ace/native-session";

const contextTags = [
  "recommended_plugins",
  "local-command-caveat",
  "local-command-stdout",
  "environment_context",
  "user_instructions",
  "system-reminder",
  "skills_instructions",
  "plugins_instructions",
  "command-name",
  "command-message",
];
const contextBlocks = new RegExp(`<(${contextTags.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "g");

/** Remove the context envelopes saved by CLIs and IDEs, before truncating display text. */
export function sanitizeUserText(value: string): string {
  let text = value.trim();
  // These records are standalone instructions, not a person's prompt.
  if (/^#\s+(?:AGENTS|CLAUDE)\.md\b/i.test(text)) {
    const end = text.indexOf("</INSTRUCTIONS>");
    if (end < 0) return "";
    text = text.slice(end + "</INSTRUCTIONS>".length).trimStart();
  }
  for (;;) {
    const opening = /^<([\w][\w:-]*)(?:\s[^>]*)?>/.exec(text);
    if (!opening) break;
    const tag = opening[1];
    // Other XML belongs to the person, including incomplete examples.
    if (tag !== "command-args" && !contextTags.includes(tag ?? "")) break;
    const tokens = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, "g");
    let depth = 0;
    let end = 0;
    for (const match of text.matchAll(tokens)) {
      depth += match[1] ? -1 : 1;
      if (!depth) {
        end = match.index + match[0].length;
        break;
      }
    }
    // A cut-off injected envelope must never become a title.
    if (!end) return "";
    const block = text.slice(opening[0].length, end).replace(new RegExp(`</${tag}>$`), "");
    text = (tag === "command-args" ? block + "\n" : "") + text.slice(end);
    text = text.trimStart();
  }
  text = text
    .replace(contextBlocks, "")
    .replace(/^\/(?:[\w-]+)(?:\s|$)/, "")
    .replace(/\[(?:Image|Attachment)(?:\s*\d+|\s*:)[^\]]*\]/gi, "")
    .replace(/\[Attached (?:image|file|screenshot)\b[^\]]*(?:saved at|saved to):?[^\]]*\]/gi, "")
    .replace(/^\s*(?:name|fileName):[^\n]*\n(?=\s*(?:mimeType|sizeBytes|attachmentId):)/gim, "")
    .replace(/^\s*(?:mimeType|sizeBytes|attachmentId):[^\n]*(?:\n|$)/gim, "")
    .replace(/^\s*(?:\[?Attached (?:image|file|screenshot)[^\n]*|<image>)[\n]?/gi, "")
    .trim();
  return text;
}

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
