import { createHash } from "node:crypto";
import { pageReplyBytes } from "./reply-bounds.ts";

/*
 * `interaction.read`: a request clients get summarized (ADR 0157), read back whole as pages of
 * its stored JSON. A reader asks for page after page of the same request, so the request is held
 * in memory while it is read: reading it from storage for each page would parse all of it again
 * every time. A held copy is checked against storage whenever any interaction was written since,
 * and a changed request reads under a new `version`, so a reader never joins two of them. The
 * version is the request JSON's SHA-256, so an answer naming it (`readWhole`) names exactly what
 * the person was shown.
 */

/** UTF-16 code units of request JSON one page holds: about one raw page's worth of JSON. */
export const interactionReadChars = pageReplyBytes;
/** Requests held at once, and the most code units they hold together. */
const mostHeld = 4;
const mostHeldChars = 64 * 1024 * 1024;

/** Where a request's stored JSON comes from, and how to tell storage changed. */
export interface RequestSource {
  /** Changes whenever any interaction is written. */
  writes(): number;
  request(threadId: string, id: string): { text: string; summary: boolean } | undefined;
}

export interface RequestPage {
  version: string;
  offset: number;
  nextOffset: number;
  total: number;
  text: string;
  eof: boolean;
}

interface Held {
  threadId: string;
  id: string;
  text: string;
  version: string;
  writes: number;
}

export class InteractionReads {
  private readonly source: RequestSource;
  /** Least recently read first. */
  private held: Held[] = [];
  constructor(source: RequestSource) {
    this.source = source;
  }
  /** The page of `id`'s request from `offset`, or why there is none. */
  read(
    threadId: string,
    id: string,
    offset: number,
  ): RequestPage | "interaction_not_found" | "request_not_whole_here" {
    const held = this.current(threadId, id);
    if (typeof held === "string") return held;
    const total = held.text.length;
    const start = Math.min(offset, total);
    let end = Math.min(start + interactionReadChars, total);
    // A page never ends inside a character of two code units.
    const last = held.text.charCodeAt(end - 1);
    if (end < total && end - 1 > start && last >= 0xd800 && last <= 0xdbff) end--;
    return {
      version: held.version,
      offset: start,
      nextOffset: end,
      total,
      text: held.text.slice(start, end),
      eof: end === total,
    };
  }
  /** The version `id`'s request reads under now, if it can be read whole. */
  version(threadId: string, id: string): string | undefined {
    const held = this.current(threadId, id);
    return typeof held === "string" ? undefined : held.version;
  }
  private current(
    threadId: string,
    id: string,
  ): Held | "interaction_not_found" | "request_not_whole_here" {
    const writes = this.source.writes();
    const index = this.held.findIndex((entry) => entry.threadId === threadId && entry.id === id);
    const found = index === -1 ? undefined : this.held[index];
    if (found && found.writes === writes) {
      this.held.push(...this.held.splice(index, 1));
      return found;
    }
    if (found) this.held.splice(index, 1);
    const stored = this.source.request(threadId, id);
    if (!stored) return "interaction_not_found";
    if (stored.summary) return "request_not_whole_here";
    const entry: Held = {
      threadId,
      id,
      text: stored.text,
      version:
        found?.text === stored.text
          ? found.version
          : createHash("sha256").update(stored.text).digest("hex"),
      writes,
    };
    this.held.push(entry);
    let chars = this.held.reduce((sum, held) => sum + held.text.length, 0);
    while (this.held.length > 1 && (this.held.length > mostHeld || chars > mostHeldChars))
      chars -= this.held.shift()?.text.length ?? 0;
    return entry;
  }
}
