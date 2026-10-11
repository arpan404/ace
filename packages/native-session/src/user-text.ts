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
const contextOpening = new RegExp(`<(${contextTags.join("|")})\\b[^>]*>`, "i");

/** Also hide nested and unfinished envelopes in a streamed text part. */
function withoutContextBlocks(value: string): string {
  let text = value;
  for (;;) {
    const opening = contextOpening.exec(text);
    if (!opening) return text;
    const tag = opening[1];
    const tokens = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, "gi");
    tokens.lastIndex = opening.index;
    let depth = 0;
    let end = text.length;
    for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
      depth += token[1] ? -1 : 1;
      if (!depth) {
        end = tokens.lastIndex;
        break;
      }
    }
    text = text.slice(0, opening.index) + text.slice(end);
  }
}

// Standalone handoffs contain generated instructions rather than a new request.
const wrapperPatterns = [
  { pattern: /^The user interrupted the previous turn on purpose\b[\s\S]*/i, replacement: "" },
  { pattern: /^A previous agent produced the plan below\b[\s\S]*/i, replacement: "" },
  {
    pattern: /^Continue this conversation using the transcript context below\b[\s\S]*/i,
    replacement: "",
  },
  { pattern: /\[User attached one or more images\b[^\]]*(?:\]|$)/gi, replacement: "" },
  { pattern: /^Title request:\s*/i, replacement: "" },
];

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
  text = withoutContextBlocks(text)
    .replace(/^\/(?:[\w-]+)(?:\s|$)/, "")
    .replace(/\[(?:Image|Attachment)(?:\s*\d+|\s*:)[^\]]*\]/gi, "")
    .replace(/\[Attached (?:image|file|screenshot)\b[^\]]*(?:saved at|saved to):?[^\]]*\]/gi, "")
    .replace(/^\s*(?:name|fileName):[^\n]*\n(?=\s*(?:mimeType|sizeBytes|attachmentId):)/gim, "")
    .replace(/^\s*(?:mimeType|sizeBytes|attachmentId):[^\n]*(?:\n|$)/gim, "")
    .replace(/^\s*(?:\[?Attached (?:image|file|screenshot)[^\n]*|<image>)[\n]?/gi, "")
    .trim();
  for (const wrapper of wrapperPatterns)
    text = text.replace(wrapper.pattern, wrapper.replacement).trim();
  return text;
}
