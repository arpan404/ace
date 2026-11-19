import { withoutPortableHandoff } from "@ace/projection";
import type { ContentPart } from "@ace/protocol";
import { attachmentMarker } from "./composer-markers.ts";

/*
 * A thread's provisional title, from its first message (UX audit TN-1). The daemon titles a new
 * thread with this when it admits that message; the UI uses it too, so the sidebar row, a draft
 * row and the header read it the moment Enter is pressed, before the daemon has replied. The
 * rule: the first line with words in it, as plain words (no Markdown, @mentions, file chips or
 * file markers, however they are nested), collapsed to single spaces, at most 60 characters.
 */

/** What a thread is called until its first message has words in it. */
export const untitledThread = "New thread";

const titleLimit = 60;

/** The first line of the message's text that has anything but spaces in it. */
function firstLine(parts: readonly ContentPart[]): string {
  const text = withoutPortableHandoff(parts)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  for (const line of text.split(/\r?\n/)) if (line.trim()) return line;
  return "";
}

/** The line as plain words: links read as their words; chips, mentions and markup go. */
function prose(line: string): string {
  return (
    line
      // [words](url) and ![alt](url): the words stay.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // [file: a.png], [image: …], [attachment: …]: a chip, not words.
      .replace(/\[(?:file|image|attachment):[^\]]*\]/gi, "")
      // A file's place in a composer's words: its chip, not words.
      .replaceAll(attachmentMarker, "")
      // Emphasis and code marks, before mentions so `**@name**` reads as a mention.
      .replace(/[*_`~]/g, "")
      // @path/to/file: a mention, not words (an email's @ follows a letter, so it stays).
      .replace(/(^|\s)@[\w./-]+/g, "$1")
      // A heading, quote or list marker before the words.
      .replace(/^[\s#>+-]+/, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The provisional title for a first message: "Fix the login redirect" for
 * "# **Fix** @agent the [login](…) redirect". Longer than 60 characters, it ends at the last
 * word that fits, with "…". A message without words is called `fallback` ("New thread").
 */
export function provisionalTitle(
  parts: readonly ContentPart[],
  fallback: string = untitledThread,
): string {
  const text = prose(firstLine(parts));
  if (!text) return fallback;
  if (text.length <= titleLimit) return text;
  // Room for the ellipsis inside the limit.
  const room = text.slice(0, titleLimit - 1);
  const space = room.lastIndexOf(" ");
  return `${space > 0 ? room.slice(0, space) : room}…`;
}
