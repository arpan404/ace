import type { Author } from "./attribution.ts";
import { Buffer, type BufferContext } from "./buffer.ts";
import type {
  BufferKey,
  BufferLease,
  DiskFile,
  DraftStore,
  FilePort,
  MergePort,
  Schedule,
  TextBuffer,
} from "./types.ts";

/** Spec 57: buffer text across every thread. */
export const defaultCapBytes = 64 * 1024 * 1024;
/** Spec 53: a draft is written once typing pauses this long. */
export const defaultDraftDelay = 400;

export interface BufferRegistryOptions {
  files: FilePort;
  drafts: DraftStore;
  merge: MergePort;
  now(): number;
  schedule: Schedule;
  /** Resolves once the editor's Wasm can make a document. */
  ready(): Promise<void>;
  capBytes?: number;
  draftDelay?: number;
  /** Who changed a file on disk at `at` (the attribution matcher over the turn's edit calls). */
  attribute?: (key: BufferKey, at: number) => Author;
}

/** The app's one set of buffers, keyed by checkout and path, shared by every view of a file. */
export interface BufferRegistry {
  /** Holds the file's buffer, reading it on first open. */
  open(key: BufferKey): BufferLease;
  /**
   * Holds the file's buffer for a tab that may be hidden (spec 54): a new buffer reads the file
   * once it is first shown, or at once when a draft of it is kept, so its unsaved dot shows.
   */
  hold(key: BufferKey): BufferLease;
  /** The buffer if something holds it or it is unsaved. */
  get(key: BufferKey): TextBuffer | undefined;
  /** The watcher saw the file change (or `file` was read already): reload, or raise a clash. */
  diskChanged(key: BufferKey, file?: DiskFile): void;
  /** After a reconnect every open buffer of the checkout checks its version (spec 54). */
  recheck(root: string): void;
  /** Writes every pending draft now (pagehide, quit). */
  flushDrafts(): Promise<void>;
  /** Unsaved buffers, of one checkout or all. */
  unsaved(root?: string): TextBuffer[];
  /**
   * Unsaved buffers whose newest text is not yet kept on the device: a draft write failed, is
   * still out, or waits for typing to pause. Leaving now could lose it, so leaving must ask.
   */
  unkept(): TextBuffer[];
  /** Paths of a checkout with a stored draft, for reopening files the layout forgot. */
  draftPaths(root: string): Promise<string[]>;
  /** Folders of a checkout's open files, once each: the one watch set (spec 58). */
  folders(root: string): string[];
  /** UTF-8 bytes of resident buffer text. */
  residentBytes(): number;
}

const id = (key: BufferKey) => `${key.root}\u0000${key.path}`;
const folder = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

export function createBufferRegistry(options: BufferRegistryOptions): BufferRegistry {
  const cap = options.capBytes ?? defaultCapBytes;
  const buffers = new Map<string, Buffer>();
  let checking = false;

  /**
   * Frees buffers nobody holds once they are saved, then, over the cap, hidden saved buffers
   * least recently shown first. Runs after the current call stack, once per burst of changes.
   */
  const check = () => {
    if (checking) return;
    checking = true;
    queueMicrotask(() => {
      checking = false;
      for (const [key, buffer] of buffers)
        if (buffer.holders === 0 && !buffer.keeps()) {
          buffer.dispose();
          buffers.delete(key);
        }
      let total = resident();
      if (total <= cap) return;
      const candidates = [...buffers.values()]
        .filter((buffer) => buffer.evictable())
        .toSorted((a, b) => a.lastShown - b.lastShown);
      for (const buffer of candidates) {
        if (total <= cap) break;
        total -= buffer.bytes;
        buffer.evict();
      }
    });
  };

  const context: BufferContext = {
    files: options.files,
    drafts: options.drafts,
    merge: options.merge,
    now: options.now,
    schedule: options.schedule,
    ready: options.ready,
    draftDelay: options.draftDelay ?? defaultDraftDelay,
    attribute: options.attribute ?? (() => ({ kind: "unknown" })),
    changed: check,
  };

  const resident = () => {
    let total = 0;
    for (const buffer of buffers.values()) if (buffer.document()) total += buffer.bytes;
    return total;
  };

  const of = (root?: string) =>
    [...buffers.values()].filter((buffer) => root === undefined || buffer.key.root === root);

  const lease = (key: BufferKey, start: (buffer: Buffer) => void): BufferLease => {
    let buffer = buffers.get(id(key));
    if (!buffer) {
      buffer = new Buffer({ ...key }, context);
      buffers.set(id(key), buffer);
      start(buffer);
    }
    const held = buffer;
    held.holders++;
    let visible = false;
    let released = false;
    const setVisible = (next: boolean) => {
      if (released || next === visible) return;
      visible = next;
      held.visible += next ? 1 : -1;
      held.lastShown = options.now();
      if (next) held.shown();
      else check();
    };
    return {
      buffer: held,
      setVisible,
      release() {
        if (released) return;
        setVisible(false);
        released = true;
        held.holders--;
        if (held.holders > 0 || held.keeps()) return check();
        held.dispose();
        if (buffers.get(id(key)) === held) buffers.delete(id(key));
      },
    };
  };

  return {
    open: (key) => lease(key, (buffer) => void buffer.load()),
    hold: (key) => lease(key, (buffer) => buffer.defer()),
    get: (key) => buffers.get(id(key)),
    diskChanged(key, file) {
      void buffers.get(id(key))?.diskChanged(file);
    },
    recheck(root) {
      for (const buffer of of(root)) void buffer.diskChanged();
    },
    async flushDrafts() {
      await Promise.all([...buffers.values()].map((buffer) => buffer.flush()));
    },
    unsaved: (root) => of(root).filter((buffer) => buffer.snapshot().dirty),
    unkept: () => of().filter((buffer) => !buffer.keptOnDevice()),
    async draftPaths(root) {
      const drafts = await options.drafts.list(root);
      return drafts.map((entry) => entry.path).toSorted();
    },
    folders(root) {
      const held = of(root).filter((buffer) => buffer.holders > 0);
      return [...new Set(held.map((buffer) => folder(buffer.key.path)))].toSorted();
    },
    residentBytes: resident,
  };
}
