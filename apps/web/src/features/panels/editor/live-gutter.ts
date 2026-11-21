import {
  hunkMarks,
  hunksFromChanges,
  type ChangeHunk,
  type LineMark,
  type WholeLineChange,
} from "@ace/ui-core";
import type { BufferEvent, TextBuffer } from "@/features/editor-workbench/index.ts";
import { landBlocks, mapBlocks, withoutLines, type AgentBlock, type AgentWho } from "./agent-lines.ts";

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
}

const empty: GutterState = { hunks: [], marks: undefined, agent: [] };

export class LiveGutter {
  readonly #buffer: TextBuffer;
  readonly #deps: LiveGutterDeps;
  readonly #listeners = new Set<() => void>();
  readonly #off: () => void;
  /** The committed text; undefined compares against what is on disk. */
  #head: string | undefined;
  #state: GutterState = empty;
  /** The text the agent blocks are in. */
  #agentText: string | undefined;
  #agent: AgentBlock[] = [];
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

  /** The committed text, as git's diff of the file rebuilds it; undefined for none known. */
  setHead(head: string | undefined): void {
    if (head === this.#head) return;
    this.#head = head;
    this.edited();
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

  /** The person kept (or reverted) 0-based lines `start..end`: they stop being the agent's. */
  keep(start: number, end: number): void {
    const kept = withoutLines(this.#agent, start, end);
    if (kept.length === this.#agent.length) return;
    this.#agent = kept;
    this.#publish({ ...this.#state, agent: kept });
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
      this.#enqueue(() => this.#landed(event.before, event.changes, after, who, at));
      this.edited();
    } else if (event.type === "document") {
      if (!this.#buffer.document()) {
        // Freed: the text the blocks were in is gone with it.
        this.#agent = [];
        this.#agentText = undefined;
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
    before: string,
    changes: readonly WholeLineChange[],
    after: string | undefined,
    who: AgentWho | undefined,
    at: number,
  ): Promise<void> {
    if (this.#disposed || after === undefined) return;
    let blocks = this.#agent;
    if (blocks.length && this.#agentText !== undefined && this.#agentText !== before)
      blocks = mapBlocks(blocks, await this.#deps.diff.lineChanges(this.#agentText, before));
    blocks = who ? landBlocks(blocks, changes, who, at) : mapBlocks(blocks, changes);
    this.#agent = blocks;
    this.#agentText = blocks.length ? after : undefined;
    this.#publish({ ...this.#state, agent: blocks });
  }

  async #recompute(): Promise<void> {
    const doc = this.#buffer.document();
    if (this.#disposed) return;
    if (!doc) return this.#publish(empty);
    const version = doc.version();
    const text = doc.text();
    const head = this.#head ?? this.#buffer.baseText();
    const from = this.#agentText;
    const [changes, moved] = await Promise.all([
      head === undefined ? [] : this.#deps.diff.lineChanges(text, head),
      this.#agent.length && from !== undefined && from !== text
        ? this.#deps.diff.lineChanges(from, text)
        : undefined,
    ]);
    if (this.#disposed) return;
    if (moved) {
      this.#agent = mapBlocks(this.#agent, moved);
      this.#agentText = this.#agent.length ? text : undefined;
    }
    // The text moved while the diff ran: the next pause works the hunks out again.
    if (this.#buffer.document() !== doc || doc.version() !== version)
      return this.#publish({ ...this.#state, agent: this.#agent });
    const hunks = hunksFromChanges(changes, (line) => doc.line(line), doc.lenLines());
    const marks = hunkMarks(hunks);
    this.#publish({ hunks, marks: marks.size ? marks : undefined, agent: this.#agent });
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
