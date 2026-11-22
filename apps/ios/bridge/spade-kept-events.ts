import { parseSpadeStored, type SpadeFollowLink, type SpadeStored } from "@ace/ui-core/spade-chat";

/*
 * The Spade conversations this phone opened, kept as the events Spade stored, so the next open
 * folds them at once and reads only from the last of them (`SpadeLiveConversation.seed`). Spade
 * numbers a conversation's events 1, 2, 3… with no gaps and never changes one once stored, so a
 * kept log is always every event from 1 to its last: an event is kept only once the one before
 * it is, and a log read back with a gap isn't used. Kept in the phone's snapshot store
 * (`read-snapshots.ts`), and held in memory only while its conversation is open. A cache: any
 * failure is a miss.
 */

/** Where kept events last between launches: the phone's snapshot store. */
export interface SpadeKeep {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** What `later` the store saves on. */
type Later = (delay: number, callback: () => void) => () => void;

/** A conversation longer than this (its events' JSON, in UTF-8) isn't kept; it reads from Spade. */
export const keptLimit = 4 * 1024 * 1024;
/** Events are saved this long after the last arrived, so a reply's burst writes once. */
export const keptSaveDelayMs = 1_500;
/** Events read ahead of the one kept last, waiting for those before them: eight pages' worth. */
const waitingLimit = 8 * 200;

/** One conversation's kept events, each as Spade stored it: seq 1 to `raw.length`. */
export interface SpadeKeptLog {
  raw: unknown[];
  /** Their JSON's size in UTF-8. */
  bytes: number;
}

export class SpadeKeptEvents {
  private readonly keep: SpadeKeep | undefined;
  private readonly later: Later;
  private readonly key: (conversation: string) => string;

  constructor(keep: SpadeKeep | undefined, later: Later, key: (conversation: string) => string) {
    this.keep = keep;
    this.later = later;
    this.key = key;
  }

  /** The events kept from an earlier open; none when there are none, or they can't be used. */
  async load(conversation: string): Promise<SpadeKeptLog | undefined> {
    let value: unknown;
    try {
      value = await this.keep?.get(this.key(conversation));
    } catch {
      return undefined;
    }
    return Array.isArray(value) ? logOf(value) : undefined;
  }

  /**
   * `link` as the follow of `conversation` reads through it, every stored event it brings kept in
   * `seq` order as it passes: history pages and live `stored` frames. Returns the link; how to go
   * on from a loaded log (`adopt`, before the follow reads); how to start over (the kept events
   * weren't Spade's); and how to stop, which saves what is unsaved and lets go of the events.
   */
  record(conversation: string, link: SpadeFollowLink) {
    let raw: unknown[] = [];
    let bytes = 0;
    /** Read ahead of the last kept event, by seq, until those before them arrive. */
    let waiting = new Map<number, { raw: unknown; bytes: number }>();
    /** Grew past `keptLimit`: nothing more is kept, and the saved copy goes. */
    let over = false;
    let dirty = false;
    let cancel: (() => void) | undefined;
    const save = () => {
      cancel?.();
      cancel = undefined;
      if (!dirty || !this.keep) return;
      dirty = false;
      void this.keep.set(this.key(conversation), over ? [] : raw.slice()).catch(() => {});
    };
    const take = (event: unknown, size: number) => {
      raw.push(event);
      bytes += size;
      if (bytes > keptLimit) {
        over = true;
        raw = [];
        waiting = new Map();
      }
      dirty = true;
      cancel ??= this.later(keptSaveDelayMs, save);
    };
    const add = (event: unknown, size: number) => {
      const seq = seqOf(event);
      if (over || seq === undefined || seq <= raw.length) return;
      if (seq > raw.length + 1) {
        // Ahead of a page still out: it waits for the ones before it, never leaving a gap.
        if (waiting.size < waitingLimit) waiting.set(seq, { raw: event, bytes: size });
        return;
      }
      take(event, size);
      for (let next = waiting.get(raw.length + 1); next; next = waiting.get(raw.length + 1)) {
        waiting.delete(raw.length + 1);
        take(next.raw, next.bytes);
        if (over) return;
      }
      for (const ahead of waiting.keys()) if (ahead <= raw.length) waiting.delete(ahead);
    };
    const reset = () => {
      raw = [];
      bytes = 0;
      waiting = new Map();
      over = false;
      dirty = true;
    };
    const kept: SpadeFollowLink = {
      canOpen: () => link.canOpen(),
      onOpenable: (listener) => link.onOpenable(listener),
      open: (path, sink) =>
        link.open(path, {
          frame(event, data) {
            if (event === "stored") add(json(data), utf8Length(data));
            sink.frame(event, data);
          },
          ended: (reason, status) => sink.ended(reason, status),
        }),
      async read(path) {
        const body = await link.read(path);
        if (/\/events\?after=\d+/.test(path)) {
          const rows = json(body);
          if (Array.isArray(rows)) for (const row of rows) add(row, sizeOf(row));
        }
        return body;
      },
    };
    const stop = () => {
      save();
      raw = [];
      waiting = new Map();
    };
    const adopt = (log: SpadeKeptLog) => {
      if (raw.length) return;
      raw = log.raw;
      bytes = log.bytes;
    };
    return { link: kept, adopt, reset, stop };
  }
}

/** Kept events as read back, each with its seq; undefined unless they run 1, 2, 3… unbroken. */
export function logOf(value: readonly unknown[]): SpadeKeptLog | undefined {
  let bytes = 0;
  for (const [index, raw] of value.entries()) {
    if (seqOf(raw) !== index + 1) return undefined;
    bytes += sizeOf(raw);
    if (bytes > keptLimit) return undefined;
  }
  return { raw: [...value], bytes };
}

/** Kept events, ready to fold. */
export function keptStored(log: SpadeKeptLog): SpadeStored[] {
  return log.raw.flatMap((each) => {
    const stored = parseSpadeStored(each);
    return stored ? [stored] : [];
  });
}

function seqOf(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null || !("seq" in raw)) return undefined;
  const { seq } = raw;
  return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : undefined;
}

const sizeOf = (raw: unknown) => utf8Length(JSON.stringify(raw) ?? "");

/** How many bytes `text` takes in UTF-8. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
