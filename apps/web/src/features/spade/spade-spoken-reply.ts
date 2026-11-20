import { spadePlainText } from "@ace/ui-core/spade-chat";

/*
 * What a bot's reply sounds like (ADR 0134, amended): its words as sentences, ready to speak
 * while the reply is still being written. Code, tables and long lists are never read; each
 * becomes one short line saying it is on screen. A short list is read item by item.
 *
 * `push` takes the reply's whole text so far and answers only the sentences completed since the
 * last call. Finished lines are read once; only the line still being written is looked at
 * again, so the work per delta is the size of that line, not of the reply.
 */

/** At most this many items are read aloud; a longer list is summed up in one line. */
export const readListItems = 3;

export const spokenCode = "The code is on screen.";
export const spokenTable = "There's a table on screen.";
export const spokenList = (items: number) => `There's a list of ${items} items on screen.`;

type Block = "prose" | "code" | "table" | "list";

const fence = /^\s{0,3}(```|~~~)/;
const listItem = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
const heading = /^\s{0,3}#{1,6}\s+(.*)$/;
const tableRow = /^\s{0,3}\|/;
/** The end of a sentence: its stop, any closing quotes or brackets, then a space. */
const sentenceEnd = /[.!?…]+["'”’)\]]*\s+/g;

export interface SpokenReply {
  /** The sentences completed in `text` (the reply so far) since the last call. */
  push(text: string): string[];
  /** The rest, once the reply is finished: whatever is left is spoken too. */
  finish(text: string): string[];
}

/** Words as they should sound: marks dropped, addresses not spelled out. */
export function speakable(words: string): string {
  return spadePlainText(words)
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/\s+/g, " ")
    .trim();
}

export function spokenReply(): SpokenReply {
  /** Where the next unread line starts. */
  let at = 0;
  let block: Block = "prose";
  let fenceMark = "";
  /** The paragraph's finished lines, and how much of it (with the open line) was spoken. */
  let paragraph = "";
  let spokenUpTo = 0;
  let items: string[] = [];
  let lastSaid = "";

  const say = (out: string[], words: string) => {
    const sentence = speakable(words);
    if (!sentence) return;
    // Two code blocks in a row are one line, not two of the same.
    if (sentence === lastSaid && (sentence === spokenCode || sentence === spokenTable)) return;
    lastSaid = sentence;
    out.push(sentence);
  };

  /** The complete sentences of `prose` after what was spoken; all of it when `whole`. */
  const sentences = (out: string[], prose: string, whole: boolean) => {
    sentenceEnd.lastIndex = spokenUpTo;
    for (let match = sentenceEnd.exec(prose); match; match = sentenceEnd.exec(prose)) {
      const end = match.index + match[0].length;
      say(out, prose.slice(spokenUpTo, end));
      spokenUpTo = end;
    }
    if (whole) {
      say(out, prose.slice(spokenUpTo));
      spokenUpTo = prose.length;
    }
  };

  const endParagraph = (out: string[]) => {
    if (paragraph) sentences(out, paragraph, true);
    paragraph = "";
    spokenUpTo = 0;
  };

  const endList = (out: string[]) => {
    if (block !== "list") return;
    if (items.length > readListItems) say(out, spokenList(items.length));
    else for (const item of items) say(out, /[.!?…]$/.test(item.trim()) ? item : `${item}.`);
    items = [];
    block = "prose";
  };

  /** One finished line. */
  const line = (out: string[], text: string) => {
    if (block === "code") {
      if (text.trimStart().startsWith(fenceMark)) block = "prose";
      return;
    }
    const opened = fence.exec(text);
    if (opened) {
      endParagraph(out);
      endList(out);
      fenceMark = opened[1] ?? "```";
      block = "code";
      say(out, spokenCode);
      return;
    }
    if (tableRow.test(text)) {
      endParagraph(out);
      endList(out);
      if (block !== "table") say(out, spokenTable);
      block = "table";
      return;
    }
    if (!text.trim()) {
      endParagraph(out);
      // A blank line between items keeps the list going; one after a table ends it.
      if (block === "table") block = "prose";
      return;
    }
    const item = listItem.exec(text);
    if (item) {
      endParagraph(out);
      if (block === "table") block = "prose";
      block = "list";
      items.push(item[1] ?? "");
      return;
    }
    if (block === "list" && /^\s{2,}\S/.test(text)) {
      items[items.length - 1] = `${items.at(-1) ?? ""} ${text.trim()}`;
      return;
    }
    endList(out);
    if (block === "table") block = "prose";
    const titled = heading.exec(text);
    if (titled) {
      endParagraph(out);
      say(out, titled[1] ?? "");
      return;
    }
    paragraph = paragraph ? `${paragraph} ${text.trim()}` : text.trim();
    // The paragraph's earlier sentences were spoken from the open line; keep their place (the
    // open line's trailing space, gone now, may have been counted).
    spokenUpTo = Math.min(spokenUpTo, paragraph.length);
    sentences(out, paragraph, false);
  };

  /** The line still being written: only plain prose can be spoken before it ends. */
  const openLine = (out: string[], text: string) => {
    if (block !== "prose" && block !== "list") return;
    const trimmed = text.trimStart();
    if (!trimmed || block === "list") return;
    if (/^(`|~|\||#|[-*+]|\d)/.test(trimmed)) return;
    // Its trailing space stays: it is what says the last sentence is finished.
    sentences(out, paragraph ? `${paragraph} ${trimmed}` : trimmed, false);
  };

  const read = (text: string, whole: boolean): string[] => {
    const out: string[] = [];
    // The reply was rewritten from the start (a snapshot): read on from where it now ends.
    if (text.length < at) at = text.length;
    for (let end = text.indexOf("\n", at); end !== -1; end = text.indexOf("\n", at)) {
      line(out, text.slice(at, end));
      at = end + 1;
    }
    if (whole) {
      if (at < text.length) line(out, text.slice(at));
      at = text.length;
      endParagraph(out);
      endList(out);
      return out;
    }
    openLine(out, text.slice(at));
    return out;
  };

  return {
    push: (text) => read(text, false),
    finish: (text) => read(text, true),
  };
}

/** All of a finished reply's spoken sentences at once (Read aloud). */
export function spokenSentences(text: string): string[] {
  return spokenReply().finish(text);
}
