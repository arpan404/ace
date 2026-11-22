import { parseSpadeStored, type SpadeFollowLink, type SpadeStored } from "@ace/ui-core/spade-chat";

/*
 * The Spade conversations this phone opened, kept as the events Spade stored (immutable once
 * stored, in `seq` order), so the next open folds them at once and reads only what came after
 * (`SpadeLiveConversation.seed`). Kept in memory for this run and in the phone's snapshot store
 * (`read-snapshots.ts`) for the next launch. A cache: any failure is a miss.
 */

/** Where kept events last between launches: the phone's snapshot store. */
export interface SpadeKeep {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** What `later` the store saves on. */
type Later = (delay: number, callback: () => void) => () => void;

/** Conversations held in memory, the most recently opened kept. */
const inMemory = 4;
/** A conversation longer than this (its events' JSON) isn't kept; it reads from Spade. */
export const keptLimit = 4 * 1024 * 1024;
/** Events are saved this long after the last arrived, so a reply's burst writes once. */
export const keptSaveDelayMs = 1_500;

const keyOf = (conversation: string) => `spade-events/${conversation}`;

/** One conversation's kept events: each as Spade stored it, and the last `seq` among them. */
interface Log {
  raw: unknown[];
  last: number;
  bytes: number;
}

export class SpadeKeptEvents {
  private readonly memory = new Map<string, Log>();
  private readonly keep: SpadeKeep | undefined;
  private readonly later: Later;

  constructor(keep: SpadeKeep | undefined, later: Later) {
    this.keep = keep;
    this.later = later;
  }

  /** The events kept this run, at once; undefined when none are in memory. */
  now(conversation: string): SpadeStored[] | undefined {
    const log = this.memory.get(conversation);
    if (!log || log.last === 0) return undefined;
    this.remember(conversation, log);
    return parsed(log.raw);
  }

  /**
   * The events kept from an earlier launch, read into this run's copy while it holds none, so
   * what the follow reads next is kept after them; none when they can't be read.
   */
  async load(conversation: string): Promise<SpadeStored[]> {
    let value: unknown;
    try {
      value = await this.keep?.get(keyOf(conversation));
    } catch {
      return [];
    }
    const read = Array.isArray(value) ? logOf(value) : undefined;
    const log = this.memory.get(conversation);
    if (!log) {
      if (read) this.remember(conversation, read);
      return read ? parsed(read.raw) : [];
    }
    // This run kept some meanwhile: those are newer than the disk's.
    if (log.last === 0 && read) Object.assign(log, read);
    return parsed(log.raw);
  }

  /**
   * `link` as the follow of `conversation` reads through it, every stored event it brings kept
   * as it passes: history pages and live `stored` frames. Returns the link and how to stop,
   * which saves what is unsaved.
   */
  record(conversation: string, link: SpadeFollowLink) {
    const log: Log = this.memory.get(conversation) ?? { raw: [], last: 0, bytes: 0 };
    this.remember(conversation, log);
    let cancel: (() => void) | undefined;
    let dirty = false;
    const save = () => {
      cancel?.();
      cancel = undefined;
      if (!dirty || !this.keep) return;
      dirty = false;
      void this.keep.set(keyOf(conversation), log.bytes > keptLimit ? [] : log.raw).catch(() => {});
    };
    const add = (raw: unknown, bytes: number) => {
      const seq = seqOf(raw);
      if (seq === undefined || seq <= log.last) return;
      log.raw.push(raw);
      log.last = seq;
      log.bytes += bytes;
      dirty = true;
      cancel ??= this.later(keptSaveDelayMs, save);
    };
    const reset = () => {
      log.raw = [];
      log.last = 0;
      log.bytes = 0;
      dirty = true;
    };
    const kept: SpadeFollowLink = {
      canOpen: () => link.canOpen(),
      onOpenable: (listener) => link.onOpenable(listener),
      open: (path, sink) =>
        link.open(path, {
          frame(event, data) {
            if (event === "stored") add(json(data), data.length);
            sink.frame(event, data);
          },
          ended: (reason, status) => sink.ended(reason, status),
        }),
      async read(path) {
        const body = await link.read(path);
        const after = /\/events\?after=(\d+)/.exec(path)?.[1];
        if (after !== undefined) {
          // A read from the start is the whole history again: what was kept is replaced.
          if (after === "0") reset();
          const rows = json(body);
          if (Array.isArray(rows)) {
            const each = rows.length ? body.length / rows.length : 0;
            for (const row of rows) add(row, each);
          }
        }
        return body;
      },
    };
    return { link: kept, reset, stop: save };
  }

  /** The most recently opened stay in memory. */
  private remember(conversation: string, log: Log) {
    this.memory.delete(conversation);
    this.memory.set(conversation, log);
    for (const key of this.memory.keys()) {
      if (this.memory.size <= inMemory) break;
      this.memory.delete(key);
    }
  }
}

/** Kept events as read back; undefined unless each is a stored event, in rising `seq` order. */
function logOf(value: unknown[]): Log | undefined {
  let last = 0;
  for (const raw of value) {
    const seq = seqOf(raw);
    if (seq === undefined || seq <= last) return undefined;
    last = seq;
  }
  return { raw: value, last, bytes: 0 };
}

function parsed(raw: readonly unknown[]): SpadeStored[] {
  return raw.flatMap((each) => {
    const stored = parseSpadeStored(each);
    return stored ? [stored] : [];
  });
}

function seqOf(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null || !("seq" in raw)) return undefined;
  const { seq } = raw;
  return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : undefined;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
