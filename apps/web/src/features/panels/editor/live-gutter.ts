import type { EditorDocument } from "@ace/editor";
import {
  hunkMarks,
  hunksFromChanges,
  revertChange,
  type ChangeHunk,
  type LineMark,
  type WholeLineChange,
} from "@ace/ui-core";
import type { BufferEvent, TextBuffer } from "@/features/editor-workbench/index.ts";
import {
  landBlocks,
  overlay,
  projectBlocks,
  sameBlocks,
  withoutLines,
  type AgentBlock,
  type AgentWho,
} from "./agent-lines.ts";

/*
 * One open file's change marks (docs/editor/workbench.md 43–44), shared by every view of it and
 * kept outside React so a tab switch keeps them: the buffer's text against the committed text
 * (added, modified, removed), and the lines an agent wrote. Typing only schedules work; once it
 * pauses, the text is diffed off the main thread (for large files) by the editor core, and an
 * agent's change moves the blocks by the lines it landed.
 */

/** The editor core's whole-line diff (the merge worker's `lineChanges`). */
export interface GutterDiff {
  lineChanges(before: string, after: string): Promise<readonly WholeLineChange[]>;
}

export interface GutterState {
  /** The text's changes since the last commit; empty when there are none. */
  hunks: readonly ChangeHunk[];
  /** Their marks by 1-based line; undefined with none. */
  marks: ReadonlyMap<number, LineMark> | undefined;
  /** Lines agents wrote, in the text's 0-based lines. */
  agent: readonly AgentBlock[];
  /** What the hunks were worked out on: a hunk acts only while all of it still holds. */
  basis?: { doc: EditorDocument; version: number; head: string; generation: string } | undefined;
}

export interface LiveGutterDeps {
  diff: GutterDiff;
  /** Runs `run` after `ms`; the returned function cancels it. */
  schedule(run: () => void, ms: number): () => void;
  now(): number;
  /** Who landed a reload or merge, read as it lands; undefined when nobody can be named. */
  who(reason: "reload" | "merge"): AgentWho | undefined;
  /** How long typing pauses before the marks are worked out again. */
  delay: number;
  /** Where attribution outlives the page (the device's storage); none keeps it in memory only. */
  memory?: AttributionMemory | undefined;
}

/** Agents' lines kept for a file, for the exact text they were measured on. */
export interface SavedAttribution {
  /** `textHash` of the text the blocks are in. */
  hash: string;
  blocks: readonly AgentBlock[];
}

export interface AttributionMemory {
  read(key: string): SavedAttribution | undefined;
  /** Undefined forgets the file's entry. */
  write(key: string, saved: SavedAttribution | undefined): void;
}

/** A short fingerprint of a text (FNV-1a over its UTF-16 units, and its length). */
export function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

const empty: GutterState = { hunks: [], marks: undefined, agent: [] };

/** One agent change: the text right after it, and the lines it wrote there. */
interface Layer {
  text: string;
  blocks: readonly AgentBlock[];
}

/** The most agent changes a file keeps apart (each costs one diff per pause); older ones go. */
const maxLayers = 8;

export class LiveGutter {
  readonly #buffer: TextBuffer;
  readonly #deps: LiveGutterDeps;
  readonly #listeners = new Set<() => void>();
  readonly #off: () => void;
  /** The committed text; undefined compares against what is on disk. */
  #head: string | undefined;
  /** Which read of git's diff the committed text came from (the commit and the disk version). */
  #generation = "";
  /** That read is the one for the text on disk now: until it is, Revert does nothing. */
  #settled = true;
  #state: GutterState = empty;
  /**
   * One layer per agent change that landed (oldest first): the text right after it, and the
   * lines it wrote there. What is shown is each layer's lines that still read as written, the
   * newer layer's where two claim a line: a line the person edited, or the agent rewrote, is
   * hidden, not lost, and an undo that puts it back shows it again.
   */
  #layers: Layer[] = [];
  /** The agent's lines as the text is now. */
  #shown: readonly AgentBlock[] = [];
  /** The device's copy was looked at for this document (once per document). */
  #recalled: object | undefined;
  /** What is kept on the device for this file: its text's hash and the lines, if anything. */
  #kept: { hash: string; blocks: readonly AgentBlock[] } | undefined;
  #cancel: (() => void) | undefined;
  /** Every change to the marks runs in order. */
  #chain: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(buffer: TextBuffer, deps: LiveGutterDeps) {
    this.#buffer = buffer;
    this.#deps = deps;
    this.#off = buffer.subscribe((event) => this.#heard(event));
    this.edited();
  }

  state(): GutterState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The committed text, as git's diff of the file rebuilds it, from the read `generation` names
   * (the commit and the disk version it was read for); undefined for none known.
   */
  setHead(head: string | undefined, generation = ""): void {
    if (head === this.#head && generation === this.#generation && this.#settled) return;
    this.#head = head;
    this.#generation = generation;
    this.#settled = true;
    this.edited();
  }

  /** A new read of git's diff is under way (a commit, a new disk version): Revert waits for it. */
  unsettle(): void {
    this.#settled = false;
  }

  /** The text changed (a view's edit): the marks are worked out again once typing pauses. */
  edited(): void {
    if (this.#disposed) return;
    this.#cancel?.();
    this.#cancel = this.#deps.schedule(() => {
      this.#cancel = undefined;
      this.#enqueue(() => this.#recompute());
    }, this.#deps.delay);
  }

  /**
   * Revert: puts `hunk`'s committed lines back as one undoable edit, unsaved. Only a hunk of the
   * marks as they are now, worked out on this very text and committed text: once either has moved
   * (typing, an agent's write, a save, a new commit) it does nothing, and the marks are worked
   * out again. The hunk's own lines and the unchanged lines around it are checked once more.
   */
  revert(hunk: ChangeHunk): boolean {
    const doc = this.#buffer.document();
    const basis = this.#state.basis;
    const head = this.#head ?? this.#buffer.baseText();
    const current =
      doc !== undefined &&
      basis !== undefined &&
      basis.doc === doc &&
      basis.version === doc.version() &&
      basis.head === head &&
      this.#settled &&
      basis.generation === this.#generation &&
      this.#state.hunks.includes(hunk);
    if (!current) {
      this.edited();
      return false;
    }
    const change = revertChange(hunk, (line) => doc.line(line), doc.lenLines(), doc.lineEnding());
    if (!change || !this.#buffer.editLines([change], { manualSave: true })) return false;
    this.edited();
    return true;
  }

  /**
   * The person kept (or reverted) 0-based lines `start..end` of the text as it is now: they stop
   * being the agent's, measured from here on.
   */
  keep(start: number, end: number): void {
    const kept = withoutLines(this.#shown, start, end);
    if (kept.length === this.#shown.length) return;
    // Kept lines end their layers' claim: what is left becomes one layer of the text now.
    const text = this.#buffer.document()?.text();
    this.#layers = kept.length && text !== undefined ? [{ text, blocks: kept }] : [];
    this.#shown = kept;
    this.#publish({ ...this.#state, agent: kept });
    this.#remember(text);
  }

  /** Settles once the scheduled and queued work has run (tests, and a review's first look). */
  async settled(): Promise<void> {
    await this.#chain;
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancel?.();
    this.#off();
    this.#listeners.clear();
  }

  #heard(event: BufferEvent): void {
    if (event.type === "replaced") {
      // Who landed it is read now: a merge's clash is gone once it has landed.
      const who = this.#deps.who(event.reason);
      const after = this.#buffer.document()?.text();
      const at = this.#deps.now();
      this.#enqueue(() => this.#landed(event.changes, after, who, at));
      this.edited();
    } else if (event.type === "document") {
      if (!this.#buffer.document()) {
        // Freed: the device's copy brings the lines back when the text is read again.
        this.#layers = [];
        this.#shown = [];
        this.#publish(empty);
      }
      this.edited();
    } else if (event.type === "state") {
      // A save or a merge moves the base the marks fall back to.
      if (this.#head === undefined) this.edited();
    }
  }

  #enqueue(run: () => Promise<void>): void {
    this.#chain = this.#chain.then(run).catch(() => undefined);
  }

  async #landed(
    changes: readonly WholeLineChange[],
    after: string | undefined,
    who: AgentWho | undefined,
    at: number,
  ): Promise<void> {
    if (this.#disposed || after === undefined) return;
    // A change nobody can be named for adds no layer: the earlier layers simply see it as an
    // edit at the next pause. A named one adds the lines it wrote, in the text it left.
    if (who) {
      const blocks = landBlocks([], changes, who, at);
      this.#layers = [...this.#layers, { text: after, blocks }].slice(-maxLayers);
    }
    // Until the next pause works every layer out, the lines shown move through this change.
    const moved = projectBlocks(this.#shown, changes);
    this.#shown = who ? overlay([landBlocks([], changes, who, at), moved]) : moved;
    this.#publish({ ...this.#state, agent: this.#shown });
    this.#remember(after);
  }

  /** The key the device keeps this file's attribution under. */
  #key(): string {
    return `${this.#buffer.key.root}\u0000${this.#buffer.key.path}`;
  }

  /** Keeps the shown lines for `text` on the device, or forgets them when there are none. */
  #remember(text: string | undefined): void {
    const memory = this.#deps.memory;
    if (!memory) return;
    if (this.#shown.length && text !== undefined) {
      const hash = textHash(text);
      if (this.#kept?.hash === hash && this.#kept.blocks === this.#shown) return;
      this.#kept = { hash, blocks: this.#shown };
      memory.write(this.#key(), this.#kept);
    } else if (this.#kept) {
      memory.write(this.#key(), undefined);
      this.#kept = undefined;
    }
  }

  /** A document read afresh (a reload): the device's lines, if they were kept for this text. */
  #recall(doc: object, text: string): void {
    if (this.#recalled === doc) return;
    this.#recalled = doc;
    if (this.#layers.length) return;
    const saved = this.#deps.memory?.read(this.#key());
    if (!saved) return;
    this.#kept = saved;
    if (saved.hash !== textHash(text)) return;
    this.#layers = [{ text, blocks: [...saved.blocks] }];
    this.#shown = this.#layers[0]?.blocks ?? [];
  }

  async #recompute(): Promise<void> {
    const doc = this.#buffer.document();
    if (this.#disposed) return;
    if (!doc) return this.#publish(empty);
    const version = doc.version();
    const text = doc.text();
    this.#recall(doc, text);
    const head = this.#head ?? this.#buffer.baseText();
    const layers = this.#layers;
    const [changes, ...moved] = await Promise.all([
      head === undefined ? [] : this.#deps.diff.lineChanges(text, head),
      ...layers.map((layer) =>
        layer.text === text ? [] : this.#deps.diff.lineChanges(layer.text, text),
      ),
    ]);
    if (this.#disposed) return;
    // Each layer measured against the text its change left, never rebased: an undo brings a
    // line back. Newest first, so a line the agent rewrote is the newer change's.
    const shown = overlay(
      layers.map((layer, index) => projectBlocks(layer.blocks, moved[index] ?? [])).toReversed(),
    );
    if (!sameBlocks(shown, this.#shown)) this.#shown = shown;
    this.#remember(text);
    // The text moved while the diff ran: the next pause works the hunks out again.
    if (this.#buffer.document() !== doc || doc.version() !== version)
      return this.#publish({ ...this.#state, agent: this.#shown });
    const hunks = hunksFromChanges(changes, (line) => doc.line(line), doc.lenLines());
    const marks = hunkMarks(hunks);
    this.#publish({
      hunks,
      marks: marks.size ? marks : undefined,
      agent: this.#shown,
      basis: head === undefined ? undefined : { doc, version, head, generation: this.#generation },
    });
  }

  #publish(next: GutterState): void {
    if (
      next.hunks === this.#state.hunks &&
      next.marks === this.#state.marks &&
      next.agent === this.#state.agent
    )
      return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
