import { EditorDocument } from "@ace/editor";
import type { Author } from "./attribution.ts";
import { DraftSlot } from "./draft-slot.ts";
import { opening } from "./opening.ts";
import { reconcile, type ReconcileHost } from "./reconcile.ts";
import { landLineChanges, utf8Length } from "./text-edits.ts";
import type {
  Answer,
  BufferEvent,
  BufferKey,
  BufferSnapshot,
  BufferStatus,
  BufferView,
  Clash,
  DocumentEdit,
  DiskFile,
  DraftStore,
  FilePort,
  MergePort,
  SaveOutcome,
  Schedule,
  TextBuffer,
  Theirs,
} from "./types.ts";

/** What every buffer shares, from the registry. */
export interface BufferContext {
  files: FilePort;
  drafts: DraftStore;
  merge: MergePort;
  now(): number;
  schedule: Schedule;
  /** Resolves once a Wasm document can be made. */
  ready(): Promise<void>;
  /** Typing has to pause this long before the draft is written. */
  draftDelay: number;
  attribute(key: BufferKey, at: number): Author;
  /** Resident size or holdability changed: the registry checks its cap. */
  changed(): void;
}

/** The text and version of a file read from disk, without the read's own fields. */
const theirsOf = (file: { text: string; version: string }): Theirs => ({
  text: file.text,
  version: file.version,
});

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Couldn't read the file.";

/**
 * One file's buffer: the shared document, the version it is based on, unsaved state, its draft
 * on the device and a clash with the disk. The registry decides when it lives and dies.
 */
export class Buffer implements TextBuffer {
  readonly key: BufferKey;
  /** Leases holding it, and those of them on screen. */
  holders = 0;
  visible = 0;
  /** When it was last on screen; 0 when never. */
  lastShown = 0;
  /** UTF-8 bytes of its text while resident. */
  bytes = 0;
  disposed = false;

  readonly #ctx: BufferContext;
  #doc: EditorDocument | undefined;
  #view: BufferView | undefined;
  /** Edit paths of the mounted views, newest last. */
  readonly #editors: DocumentEdit[] = [];
  /** The registry is landing text: the views' edit callbacks are not the person typing. */
  #landing = false;
  #status: BufferStatus = { kind: "loading" };
  /** The disk text and version the buffer started from. */
  #base: Theirs | undefined;
  /** The document's version at the last clean point; NaN when it has none. */
  #cleanAt = Number.NaN;
  #dirty = false;
  #clash: Clash | undefined;
  /** The buffer text a conflict's blocks were cut from. */
  #conflictMine = "";
  #draftKept = true;
  #saving: Promise<SaveOutcome> | undefined;
  #cancelDraft: (() => void) | undefined;
  /** Draft writes and deletes, started when asked and applied in order. */
  readonly #slot = new DraftSlot((kept) => this.#keep(kept));
  #generation = 0;
  /** A disk change arrived while loading or saving: look again afterwards. */
  #recheck = false;
  readonly #listeners = new Set<(event: BufferEvent) => void>();

  constructor(key: BufferKey, ctx: BufferContext) {
    this.key = key;
    this.#ctx = ctx;
  }

  document(): EditorDocument | undefined {
    return this.#doc;
  }

  view(): BufferView | undefined {
    const doc = this.#doc;
    if (!doc) return undefined;
    if (this.#view?.doc !== doc)
      this.#view = {
        doc,
        attach: (edit) => {
          this.#editors.push(edit);
          return () => {
            const index = this.#editors.lastIndexOf(edit);
            if (index >= 0) this.#editors.splice(index, 1);
          };
        },
      };
    return this.#view;
  }

  snapshot(): BufferSnapshot {
    return {
      status: this.#status,
      dirty: this.#dirty,
      clash: this.#clash,
      draftKept: this.#draftKept,
      saving: this.#saving !== undefined,
      version: this.#base?.version,
    };
  }

  baseText(): string | undefined {
    return this.#base?.text;
  }

  subscribe(listener: (event: BufferEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Unsaved work or a pending question keeps a buffer in memory. */
  keeps(): boolean {
    return this.#dirty || this.#clash !== undefined || this.#saving !== undefined;
  }

  /** Hidden, saved and resident: the cap may free it. */
  evictable(): boolean {
    return this.visible === 0 && !this.keeps() && this.#doc !== undefined;
  }

  edited(): void {
    const doc = this.#doc;
    if (!doc || this.#landing) return;
    if (!this.#dirty && doc.version() !== this.#cleanAt) {
      this.#dirty = true;
      this.#emit({ type: "state" });
    }
    this.#cancelDraft?.();
    this.#cancelDraft = this.#ctx.schedule(() => {
      this.#cancelDraft = undefined;
      void this.#persist();
    }, this.#ctx.draftDelay);
  }

  /** Writes a pending draft now (pagehide, quit). */
  flush(): Promise<void> {
    if (this.#cancelDraft) {
      this.#cancelDraft();
      this.#cancelDraft = undefined;
      return this.#persist();
    }
    return this.#slot.settled();
  }

  async load(): Promise<void> {
    const generation = ++this.#generation;
    this.#setStatus({ kind: "loading" });
    const [read, draft, ready] = await Promise.all([
      this.#ctx.files.read(this.key).then(
        (file) => ({ ok: true as const, file }),
        (error: unknown) => ({ ok: false as const, message: message(error) }),
      ),
      this.#ctx.drafts.get(this.key).catch(() => undefined),
      this.#ctx.ready().then(
        () => true,
        () => false,
      ),
    ]);
    if (generation !== this.#generation || this.disposed) return;
    if (!ready) return this.#setStatus({ kind: "failed", message: "The editor couldn't load." });
    const next = opening(read, draft);
    if (next.kind === "status") this.#setStatus(next.status);
    else {
      const clash: Clash | undefined = next.clash && { ...next.clash, by: this.#author() };
      this.#adopt(next.text, next.base, next.dirty, clash);
      if (next.dropDraft) void this.#persist();
    }
    this.#settled();
  }

  /** The watcher or a reconnect says the file may have changed; `file` when already read. */
  async diskChanged(file?: DiskFile): Promise<void> {
    if (this.#saving || this.#status.kind === "loading") {
      this.#recheck = true;
      return;
    }
    if (this.#status.kind === "evicted") return;
    if (this.#status.kind !== "ready") {
      if (this.holders > 0) await this.load();
      return;
    }
    const generation = this.#generation;
    const disk = file ?? (await this.#ctx.files.read(this.key).catch(() => undefined));
    if (!disk || generation !== this.#generation || this.disposed) return;
    await this.#meet(disk);
  }

  save(): Promise<SaveOutcome> {
    return this.#write("save");
  }

  replace(): Promise<SaveOutcome> {
    return this.#write("replace");
  }

  async merge(): Promise<void> {
    const clash = this.#clash;
    if (clash?.kind !== "changed" && clash?.kind !== "conflict") return;
    this.#clash = { kind: "merging", theirs: clash.theirs, by: clash.by };
    this.#emit({ type: "state" });
    await reconcile(this.#reconcileHost());
  }

  async keepMine(): Promise<void> {
    const clash = this.#clash;
    const doc = this.#doc;
    if (clash?.kind !== "changed" || !doc) return;
    this.#base = clash.theirs;
    this.#clash = undefined;
    this.#cleanAt = Number.NaN;
    this.#dirty = true;
    this.#emit({ type: "state" });
    // Same text as theirs after all: #persist marks it clean and drops the draft.
    await this.#persist();
  }

  async takeTheirs(): Promise<void> {
    const clash = this.#clash;
    if (clash?.kind !== "changed") return;
    if (!(await this.#land(clash.theirs.text, "merge")) || this.#clash !== clash) return;
    this.#base = clash.theirs;
    this.#clash = undefined;
    this.#markClean();
    this.#cancelDraft?.();
    this.#cancelDraft = undefined;
    await this.#persist();
  }

  async answer(index: number, answer: Answer): Promise<void> {
    const clash = this.#clash;
    if (clash?.kind !== "conflict" || index < 0 || index >= clash.answers.length) return;
    const answers = clash.answers.with(index, answer);
    this.#clash = { ...clash, answers };
    this.#emit({ type: "state" });
    if (answers.includes(undefined)) return;
    await reconcile(this.#reconcileHost(), {
      chunks: clash.chunks,
      answers,
      mine: this.#conflictMine,
    });
  }

  async discard(): Promise<void> {
    this.#cancelDraft?.();
    this.#cancelDraft = undefined;
    this.#dirty = false;
    this.#clash = undefined;
    // The person chose to drop the edits: a draft store that can't be reached changes nothing.
    const key = this.key;
    await this.#slot.write(() => this.#ctx.drafts.delete(key), true);
    this.#free();
    await this.load();
  }

  async reload(): Promise<void> {
    if (this.keeps()) return;
    await this.load();
  }

  /**
   * Not read yet: the file is read when first shown (spec 54), or now when a draft of it is kept,
   * so a hidden tab still says it is unsaved.
   */
  defer(): void {
    const generation = this.#generation;
    this.#setStatus({ kind: "evicted" });
    void this.#ctx.drafts.get(this.key).then(
      (draft) => {
        if (draft && generation === this.#generation && this.#status.kind === "evicted")
          void this.load();
      },
      () => undefined,
    );
  }

  /** Shown again after the cap freed it, or for the first time after `defer`. */
  shown(): void {
    if (this.#status.kind === "evicted") void this.load();
  }

  evict(): void {
    if (!this.evictable()) return;
    this.#free();
    this.#setStatus({ kind: "evicted" });
  }

  dispose(): void {
    this.disposed = true;
    this.#generation++;
    this.#cancelDraft?.();
    this.#free();
  }

  // The disk and the buffer.

  async #meet(read: DiskFile): Promise<void> {
    const base = this.#base;
    if (!base) return;
    if (read.kind === "unreadable") {
      if (!this.keeps()) {
        this.#free();
        this.#setStatus({ kind: "unreadable", reason: read.reason });
      }
      return;
    }
    if (read.kind === "missing") {
      if (this.keeps()) {
        this.#clash = { kind: "deleted", by: this.#author() };
        this.#emit({ type: "state" });
      } else {
        this.#free();
        this.#setStatus({ kind: "missing" });
      }
      return;
    }
    const disk = theirsOf(read);
    const clash = this.#clash;
    const known = clash && "theirs" in clash ? clash.theirs.version : base.version;
    if (disk.version === known && clash?.kind !== "deleted") return;
    if (!this.keeps()) {
      // A clean buffer reloads in place; typing that starts meanwhile turns it into a clash.
      if (await this.#land(disk.text, "reload")) {
        this.#base = disk;
        this.#markClean();
        return this.#ctx.changed();
      }
      if (!this.#doc || this.#base !== base) return;
    }
    const by = clash?.kind === "merging" ? clash.by : this.#author();
    this.#clash =
      clash?.kind === "merging"
        ? { ...clash, theirs: disk }
        : { kind: "changed", theirs: disk, by };
    this.#emit({ type: "state" });
  }

  async #write(mode: "save" | "replace"): Promise<SaveOutcome> {
    if (this.#saving) return this.#saving;
    const doc = this.#doc;
    const base = this.#base;
    const clash = this.#clash;
    if (!doc || !base || this.#status.kind !== "ready") return { kind: "unavailable" };
    if (mode === "save") {
      if (clash?.kind === "conflict" || clash?.kind === "merging") return { kind: "unanswered" };
      if (clash) return { kind: "clash" };
      if (!this.#dirty) return { kind: "unchanged" };
    }
    const expected = clash?.kind === "deleted" ? null : clash ? clash.theirs.version : base.version;
    const text = doc.text();
    const at = doc.version();
    const running = (async (): Promise<SaveOutcome> => {
      try {
        const result = await this.#ctx.files.write(this.key, text, expected);
        if (result.kind === "clash") {
          const disk = await this.#ctx.files.read(this.key).catch(() => undefined);
          if (disk) await this.#meet(disk);
          return { kind: "clash" };
        }
        this.#base = { text, version: result.version };
        this.#clash = undefined;
        if (doc.version() === at) this.#markClean();
        else this.#unclean();
        this.#cancelDraft?.();
        this.#cancelDraft = undefined;
        void this.#persist();
        return { kind: "saved", version: result.version };
      } catch (error) {
        return { kind: "failed", message: message(error) };
      }
    })();
    this.#saving = running;
    this.#emit({ type: "state" });
    const outcome = await running;
    this.#saving = undefined;
    this.#emit({ type: "state" });
    this.#settled();
    return outcome;
  }

  #reconcileHost(): ReconcileHost {
    return {
      doc: () => this.#doc,
      base: () => this.#base,
      clash: () => this.#clash,
      merge: this.#ctx.merge,
      land: (text) => this.#land(text, "merge"),
      setClash: (clash, mine) => {
        this.#clash = clash;
        if (mine !== undefined) this.#conflictMine = mine;
        this.#emit({ type: "state" });
      },
      rebase: (theirs, text, newer, by) => {
        this.#base = theirs;
        this.#clash = newer && { kind: "changed", theirs: newer, by };
        if (text === theirs.text && !newer) this.#markClean();
        else this.#unclean();
        void this.#persist();
      },
    };
  }

  /** Puts `next` in the document by changed blocks; false if the document moved meanwhile. */
  async #land(next: string, reason: "reload" | "merge"): Promise<boolean> {
    const doc = this.#doc;
    if (!doc) return false;
    const at = doc.version();
    const changes = await this.#ctx.merge.lineChanges(doc.text(), next);
    if (this.#doc !== doc || doc.version() !== at) return false;
    this.#landing = true;
    try {
      landLineChanges(doc, changes, this.#editors.at(-1));
    } finally {
      this.#landing = false;
    }
    this.bytes = utf8Length(next);
    this.#emit({ type: "replaced", reason });
    return true;
  }

  // State and storage.

  #adopt(text: string, base: Theirs, dirty: boolean, clash?: Clash): void {
    this.#free();
    const doc = new EditorDocument(text);
    this.#doc = doc;
    this.#base = base;
    this.#dirty = dirty;
    this.#cleanAt = dirty ? Number.NaN : doc.version();
    this.#clash = clash;
    this.bytes = utf8Length(text);
    this.#status = { kind: "ready" };
    this.#emit({ type: "document" });
    this.#emit({ type: "state" });
  }

  #free(): void {
    if (!this.#doc) return;
    this.#doc.dispose();
    this.#doc = undefined;
    this.bytes = 0;
    this.#emit({ type: "document" });
  }

  #markClean(): void {
    const doc = this.#doc;
    if (doc) this.#cleanAt = doc.version();
    this.#dirty = false;
    this.#emit({ type: "state" });
  }

  /**
   * The base moved under text typed since: the buffer is unsaved against it, even if an earlier
   * look marked the text clean against the old base. A draft write marks it clean again when the
   * text matches the new base after all.
   */
  #unclean(): void {
    this.#cleanAt = Number.NaN;
    if (this.#dirty) return;
    this.#dirty = true;
    this.#emit({ type: "state" });
  }

  #settled(): void {
    this.#ctx.changed();
    if (!this.#recheck) return;
    this.#recheck = false;
    void this.diskChanged();
  }

  /**
   * Makes the stored draft match the buffer: its text while unsaved, nothing once saved. Decided
   * and started now, so the write reflects the buffer as it is and nothing freed later skips it.
   */
  #persist(): Promise<void> {
    const doc = this.#doc;
    const base = this.#base;
    if (!doc || !base) return this.#slot.settled();
    const key = this.key;
    const text = doc.text();
    this.bytes = utf8Length(text);
    let written: Promise<void>;
    if (text === base.text && this.#clash === undefined) {
      if (this.#dirty) this.#markClean();
      written = this.#slot.write(() => this.#ctx.drafts.delete(key), true);
    } else if (this.keeps()) {
      const draft = { text, original: base.text, version: base.version };
      written = this.#slot.write(() => this.#ctx.drafts.put(key, draft));
    } else written = this.#slot.settled();
    this.#ctx.changed();
    return written;
  }

  #keep(kept: boolean): void {
    if (this.#draftKept === kept) return;
    this.#draftKept = kept;
    this.#emit({ type: "state" });
  }

  #author(): Author {
    return this.#ctx.attribute(this.key, this.#ctx.now());
  }

  #setStatus(status: BufferStatus): void {
    this.#status = status;
    this.#emit({ type: "state" });
  }

  #emit(event: BufferEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
