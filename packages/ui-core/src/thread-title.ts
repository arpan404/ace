import type { ContentPart } from "@ace/protocol";

/*
 * A thread's provisional title, from its first message (UX audit TN-1). The daemon titles a new
 * thread by the same rule when it admits that message; the UI computes it too, so the sidebar
 * row and the header read it the moment Enter is pressed, before the daemon has replied. The
 * rule is shared by spec and tests, not by code: the first line with words in it, without
 * markdown, @mentions or file chips, collapsed to single spaces, at most 60 characters.
 */

/** What a thread is called until its first message has words in it. */
export const untitledThread = "New thread";

const titleLimit = 60;

/** The first line of the message's text that has anything but spaces in it. */
function firstLine(parts: readonly ContentPart[]): string {
  const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  for (const line of text.split(/\r?\n/)) if (line.trim()) return line;
  return "";
}

/** The line as prose: links read as their words; chips, mentions and markup go. */
function prose(line: string): string {
  return (
    line
      // [words](url) and ![alt](url): the words stay.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // [file: a.png], [image: …], [attachment: …]: a chip, not words.
      .replace(/\[(?:file|image|attachment):[^\]]*\]/gi, "")
      // @path/to/file: a mention, not words (an email's @ follows a letter, so it stays).
      .replace(/(^|\s)@[\w./-]+/g, "$1")
      // A heading, quote or list marker before the words.
      .replace(/^[\s#>*+-]+/, "")
      // Emphasis and code marks.
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The provisional title for a first message: "Fix the login redirect" for
 * "# **Fix** @agent the [login](…) redirect". Longer than 60 characters, it ends at the last
 * word that fits, with "…". A message without words is a "New thread".
 */
export function provisionalTitle(parts: readonly ContentPart[]): string {
  const text = prose(firstLine(parts));
  if (!text) return untitledThread;
  if (text.length <= titleLimit) return text;
  // Room for the ellipsis inside the limit.
  const room = text.slice(0, titleLimit - 1);
  const space = room.lastIndexOf(" ");
  return `${space > 0 ? room.slice(0, space) : room}…`;
}
