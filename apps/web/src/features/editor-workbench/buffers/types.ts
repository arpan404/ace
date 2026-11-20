import type { Applied, EditorDocument, LineChange, MergeChunk, MergeResult } from "@ace/editor";
import type { MigratedDraft } from "@ace/ui-core/editor-workbench";
import type { Author } from "./attribution.ts";

/*
 * The Deck's buffers (docs/editor/workbench.md 46–58, ADR 0193 §3–5): one buffer per file per
 * checkout, shared by every view of it, outside React. What the registry cannot control (disk,
 * device storage, the merge's thread, time) comes in through the ports below.
 */

/** One file of one checkout. `root` names the checkout (machine and thread); `path` is relative. */
export interface BufferKey {
  root: string;
  path: string;
}

/** A file as the disk has it. */
export type DiskFile =
  | { kind: "text"; text: string; version: string }
  | { kind: "missing" }
  /** Binary, too large or media: not a text buffer. */
  | { kind: "unreadable"; reason: string };

export type WriteResult =
  | { kind: "saved"; version: string }
  /** The file is no longer at the expected version (or appeared where nothing was). */
  | { kind: "clash" };

/** The checkout's files: the existing read and the versioned write. */
export interface FilePort {
  read(key: BufferKey, signal?: AbortSignal): Promise<DiskFile>;
  /** Writes `text` only if the file is still at `expected` (null: nothing is there yet). */
  write(key: BufferKey, text: string, expected: string | null): Promise<WriteResult>;
}

/** Unsaved text kept on the device, with the version and text it started from. */
export type Draft = Omit<MigratedDraft, "path">;

/** Device storage for drafts (IndexedDB in the app). A failed write rejects. */
export interface DraftStore {
  get(key: BufferKey): Promise<Draft | undefined>;
  put(key: BufferKey, draft: Draft): Promise<void>;
  delete(key: BufferKey): Promise<void>;
  /** Every stored draft of one checkout, for reopening files whose layout was forgotten. */
  list(root: string): Promise<{ path: string; draft: Draft }[]>;
}

/** Runs `run` after `ms`; the returned function cancels it. */
export type Schedule = (run: () => void, ms: number) => () => void;

/** The merge's text work, off the main thread so a large file never blocks typing. */
export interface MergePort {
  merge3(base: string, mine: string, theirs: string): Promise<MergeResult>;
  lineChanges(before: string, after: string): Promise<LineChange[]>;
}

/** Where a buffer's text is. */
export type BufferStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  /** Freed under the memory cap; it reads the file again when shown. */
  | { kind: "evicted" }
  /** No file at the path and no draft for it. */
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string }
  | { kind: "failed"; message: string };

/** The disk text a clash is against. */
export interface Theirs {
  text: string;
  version: string;
}

/** One answer to a conflicting block. */
export type Answer = "mine" | "theirs";

/** The file changed on disk under unsaved edits (spec 46). */
export type Clash =
  /** The notice: Merge, Compare, or Replace on save. */
  | { kind: "changed"; theirs: Theirs; by: Author }
  /** The file was deleted on disk; saving writes it again. */
  | { kind: "deleted"; by: Author }
  | { kind: "merging"; theirs: Theirs; by: Author }
  /** Blocks both sides changed differently; Save waits until every one is answered. */
  | {
      kind: "conflict";
      theirs: Theirs;
      by: Author;
      chunks: readonly MergeChunk[];
      /** One per conflicting block, in order; undefined until answered. */
      answers: readonly (Answer | undefined)[];
    };

/** What a view reads to draw a buffer's state. */
export interface BufferSnapshot {
  status: BufferStatus;
  /** The buffer differs from what was last read or saved. */
  dirty: boolean;
  clash: Clash | undefined;
  /** False when the draft could not be stored on the device (storage full or unavailable). */
  draftKept: boolean;
  saving: boolean;
  /** The disk version the buffer is based on. */
  version: string | undefined;
}

export type BufferEvent =
  /** The snapshot changed. */
  | { type: "state" }
  /**
   * The registry replaced text in the document (a reload, a merge or a resolved conflict): a view
   * re-reads its rows and colours. Never sent for the view's own edits.
   */
  | { type: "replaced"; reason: "reload" | "merge" }
  /** The document was created or freed. */
  | { type: "document" };

export type SaveOutcome =
  | { kind: "saved"; version: string }
  /** Nothing to save. */
  | { kind: "unchanged" }
  /** The disk moved: the buffer now carries a clash; Replace is the explicit answer. */
  | { kind: "clash" }
  /** Conflicting blocks are still unanswered. */
  | { kind: "unanswered" }
  /** No text to save yet (loading, freed, unreadable). */
  | { kind: "unavailable" }
  | { kind: "failed"; message: string };

/** A mounted view's edit path: runs `run` on the document the way the view's own edits run. */
export type DocumentEdit = (run: (doc: EditorDocument) => Applied | undefined) => boolean;

/**
 * What a `CodeEditor` takes to show a shared document: the document, and `attach`, through which
 * the mounted view lends its edit path so text the registry lands (a reload, a merge) updates its
 * layout, colours and carets like the person's own edits. Stable for one document.
 */
export interface BufferView {
  doc: EditorDocument;
  attach(edit: DocumentEdit): () => void;
}

/** One shared buffer. Views and tabs hold it through a lease. */
export interface TextBuffer {
  readonly key: BufferKey;
  /** The Wasm document every view of this file shares; undefined unless status is ready. */
  document(): EditorDocument | undefined;
  /** The document for a view to show; undefined unless status is ready. Same object per document. */
  view(): BufferView | undefined;
  snapshot(): BufferSnapshot;
  /**
   * The text the buffer is based on: what was last read from disk or saved, so a view's gutter
   * marks the person's unsaved lines against it however often it remounts. Undefined until read.
   */
  baseText(): string | undefined;
  subscribe(listener: (event: BufferEvent) => void): () => void;
  /** A view applied an edit to the document. Cheap: no text is read until typing pauses. */
  edited(): void;
  save(): Promise<SaveOutcome>;
  /** The explicit answer to a clash on save: write the buffer over the disk's version. */
  replace(): Promise<SaveOutcome>;
  /** Spec 46 Merge: a clean merge lands as one undoable step, unsaved; overlaps become a conflict. */
  merge(): Promise<void>;
  /** Answers conflicting block `index`; the last answer applies the resolved text. */
  answer(index: number, answer: Answer): Promise<void>;
  /** Drops unsaved edits and the draft, and reads the disk again. */
  discard(): Promise<void>;
  /** Reads the file again after a load failure or an eviction. */
  reload(): Promise<void>;
}

/** A view's or tab's hold on a buffer. */
export interface BufferLease {
  readonly buffer: TextBuffer;
  /** The holder is on screen (a group's active editor) or not. */
  setVisible(visible: boolean): void;
  /** Lets go; a buffer nobody holds is freed unless it is unsaved. */
  release(): void;
}
