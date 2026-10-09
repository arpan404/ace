import { withoutPortableHandoff } from "@ace/projection";
import type { ContentPart } from "@ace/protocol";
/** A title uses only prose from the first nonempty line, never attachment paths. */
export function provisionalTitle(parts: readonly ContentPart[]): string {
  const line =
    withoutPortableHandoff(parts)
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .split(/\r?\n/)
      .find((candidate) => candidate.trim()) ?? "";
  const text = line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[(?:file|image|attachment):[^\]]*\]/gi, "")
    .replace(/(?:^|\s)@[\w./-]+/g, " ")
    .replace(/^[\s#>*+-]+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "New thread";
  if (text.length <= 60) return text;
  const prefix = text.slice(0, 59);
  const boundary = prefix.lastIndexOf(" ");
  return `${boundary > 0 ? prefix.slice(0, boundary) : prefix}…`;
}
