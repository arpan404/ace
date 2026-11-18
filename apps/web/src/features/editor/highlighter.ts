import type { CodeLines } from "@/components/markdown/code-lines.ts";
import { codeHash } from "@/components/markdown/code-lines.ts";
import type { CodeToken } from "@/components/markdown/highlight.ts";
import { highlightJobs } from "@/components/markdown/highlight-jobs.ts";

/** One syntax token: the shapes markit and the fallback tokenizer already produce. */
export type Token = CodeToken;

/**
 * The editor's syntax colours, addressed by line. An edit tells it exactly which lines moved;
 * the view asks only for the lines it draws. The contract markit's incremental highlighter will
 * implement natively; today's whole-file engine sits behind it in this one adapter.
 */
export interface LineHighlighter {
  /** A new document text replaces everything (open, reset, a whole-file replacement). */
  setText(text: string): void;
  /** One region changed, in post-edit coordinates: `removedLines` went, `insertedLines` came. */
  edit(startLine: number, removedLines: number, insertedLines: string[]): void;
  /** Tokens for lines `start..end`, one array per line; empty means draw plain text. */
  tokens(start: number, end: number): Token[][];
}

/** How long typing settles before the whole file is tokenized again. */
const highlightDelay = 250;

/**
 * {@link LineHighlighter} over the existing whole-file highlighter (markit's worker), off the
 * keystroke path: every change restarts a short timer, the file is tokenized once typing pauses,
 * and the last result stays on screen until the next one arrives. Lines whose text moved under
 * old tokens are checked by the view (`tokensFit`), so only untouched lines keep their colours.
 */
export class WholeFileLineHighlighter implements LineHighlighter {
  readonly #language: string | undefined;
  readonly #listeners = new Set<() => void>();
  #text = "";
  #lines: readonly CodeToken[][] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #lease: { release(): void } | undefined;
  #started = false;
  #disposed = false;

  readonly #delay: number;
  readonly #source: (() => string) | undefined;

  constructor(language: string | undefined, delay = highlightDelay, source?: () => string) {
    this.#language = language;
    this.#delay = delay;
    this.#source = source;
  }

  setText(text: string): void {
    if (text === this.#text) return;
    this.#text = text;
    // The opening file is coloured at once; only typing waits for the pause.
    this.#schedule(this.#started ? this.#delay : 0);
    this.#started = true;
  }

  /** The engine is whole-file today: an edit only schedules the next pass. */
  edit(_startLine: number, _removedLines: number, _insertedLines: string[]): void {
    this.#schedule();
  }

  tokens(start: number, end: number): Token[][] {
    const out: Token[][] = [];
    for (let line = start; line < end; line++) out.push(this.#lines[line] ?? []);
    return out;
  }

  /** Colours arrived (or the engine gave up): draw the visible lines again. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#lease?.release();
    this.#lease = undefined;
    this.#listeners.clear();
  }

  #schedule(delay = this.#delay): void {
    if (this.#disposed) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#highlight(), delay);
  }

  #highlight(): void {
    this.#timer = undefined;
    if (this.#disposed) return;
    // The caller's getter is read only here, on the debounced highlight, never on a keystroke.
    const text = this.#source ? this.#source() : this.#text;
    this.#text = text;
    const hash = codeHash(text, this.#language);
    this.#lease?.release();
    const lease = highlightJobs.acquire(
      hash,
      { code: text, lang: this.#language, hash },
      text.length * 2,
    );
    this.#lease = lease;
    void lease.result.then(
      (result) => {
        if (this.#disposed || text !== this.#text) return;
        if (result) this.#lines = linesOf(result);
        for (const listener of this.#listeners) listener();
      },
      () => undefined,
    );
  }
}

function linesOf(result: CodeLines): readonly CodeToken[][] {
  return "lines" in result ? result.lines : [];
}
