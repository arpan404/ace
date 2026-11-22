import {
  LineHighlighter as NativeLineHighlighter,
  markitWorkerPath,
  type CodeToken,
} from "@ace/markit-web";
import type { CodeToken as Token } from "@/components/markdown/highlight.ts";

/** One syntax token: the shape markit and the fallback tokenizer already produce. */
export type { Token };

/**
 * The editor's syntax colours, addressed by line. An edit tells it exactly which lines moved;
 * the view asks only for the lines it draws. markit's {@link NativeLineHighlighter} does the
 * parsing incrementally in its shared worker; this class is the synchronous face the render
 * draws from, keeping the last tokens until new ones arrive.
 */
export interface LineHighlighter {
  /** A new document text replaces everything (open, reset, a whole-file replacement). */
  setText(text: string): void;
  /** One region changed, in post-edit coordinates: `removedLines` went, `insertedLines` came. */
  edit(startLine: number, removedLines: number, insertedLines: string[]): void;
  /** Tokens for lines `start..end`, one array per line; empty means draw plain text. */
  tokens(start: number, end: number): Token[][];
}

/** How long a change waits before the visible lines are asked for tokens again. */
const defaultDelay = 30;
/** Rebuilds in a row before a broken engine is left alone until the next change. */
const maxRebuilds = 3;

/** The calls this class makes on markit's highlighter; tests pass their own. */
export interface NativeHighlighter {
  setText(text: string): Promise<void>;
  edit(startLine: number, removedLines: number, inserted: string[]): Promise<void>;
  tokens(startLine: number, endLine: number): Promise<CodeToken[][]>;
  advance(maxLines: number): Promise<boolean>;
  free(): Promise<void> | void;
}

export interface MarkitHighlighterOptions {
  /** The debounce before a new token request; tests stretch it so old colours are observable. */
  delay?: number;
  workerURL?: string;
  worker?: "shared" | "dedicated" | "inline";
  wasm?: BufferSource | WebAssembly.Module;
  grammarWasm?: BufferSource | WebAssembly.Module;
  /** Makes the engine's highlighter; tests inject one that can fail. */
  create?: (language: string) => NativeHighlighter;
}

/**
 * {@link LineHighlighter} over markit's incremental grammar highlighter. Text and edits go to
 * the shared worker in order; tokens are requested only for the visible range and cached here,
 * so React never waits on the worker. `advance` finishes extra lines on idle. The native
 * highlighter is freed with this object.
 */
export class MarkitLineHighlighter implements LineHighlighter {
  readonly #delay: number;
  readonly #listeners = new Set<() => void>();
  #ready: Promise<void>;
  readonly #language: string | undefined;
  readonly #options: MarkitHighlighterOptions;
  #native: NativeHighlighter | undefined;
  /** The whole current text, read only when the engine has to be rebuilt. */
  #source: (() => string) | undefined;
  /** A call failed: the engine's highlighter is gone (a restarted worker forgets it). */
  #broken = false;
  #rebuilds = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #cache: Token[][] = [];
  #visible = { start: 0, end: 0 };
  #requested = "";
  #generation = 0;
  #stale = true;
  /** The opening text is coloured at once; only later changes wait for the debounce. */
  #firstFetch = true;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #idle: number | undefined;
  #disposed = false;

  constructor(language: string | undefined, options: MarkitHighlighterOptions = {}) {
    this.#delay = options.delay ?? defaultDelay;
    this.#language = language;
    this.#options = options;
    this.#ready = this.#open(language, options);
    this.#ready.catch(() => undefined);
  }

  async #open(language: string | undefined, options: MarkitHighlighterOptions): Promise<void> {
    if (!language) return;
    if (options.create) {
      this.#native = options.create(language);
      return;
    }
    let native: MarkitHighlighterOptions | undefined = options.workerURL ? options : undefined;
    if (
      options.worker !== undefined ||
      options.wasm !== undefined ||
      options.grammarWasm !== undefined
    )
      native = options;
    if (!native && import.meta.env.MODE === "test") {
      const { lineHighlighterOptionsForTests } = await import("./test-support.ts");
      native = lineHighlighterOptionsForTests();
    }
    if (!native) native = { workerURL: markitWorkerPath() };
    if (this.#disposed) return;
    this.#native = new NativeLineHighlighter(language, native);
  }

  /**
   * Follows a document: its text now, and a way to read it again if the engine loses this
   * highlighter (markit's shared worker restarted), so colours come back instead of staying grey.
   */
  follow(source: () => string): void {
    this.#source = source;
    this.setText(source());
  }

  setText(text: string): void {
    this.#enqueue(async (native) => {
      await native.setText(text);
      this.#generation++;
      this.#stale = true;
      this.#scheduleFetch();
      this.#scheduleAdvance();
    });
  }

  edit(startLine: number, removedLines: number, insertedLines: string[]): void {
    this.#enqueue(async (native) => {
      await native.edit(startLine, removedLines, insertedLines);
      this.#generation++;
      this.#stale = true;
      this.#scheduleFetch();
      this.#scheduleAdvance();
    });
  }

  tokens(start: number, end: number): Token[][] {
    this.#visible = { start, end };
    const key = `${start}:${end}:${this.#generation}`;
    if (this.#stale || key !== this.#requested) this.#scheduleFetch();
    const out: Token[][] = [];
    for (let line = start; line < end; line++) out.push(this.#cache[line] ?? []);
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
    if (this.#idle !== undefined) {
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(this.#idle);
      else clearTimeout(this.#idle);
    }
    this.#listeners.clear();
    const native = this.#native;
    this.#queue.then(() => native?.free()).catch(() => undefined);
  }

  #enqueue(run: (native: NativeHighlighter) => Promise<void>): void {
    this.#queue = this.#queue
      .then(async () => {
        await this.#ready;
        if (this.#disposed || !this.#native || this.#broken) return;
        await run(this.#native);
      })
      .catch(() => this.#lost());
  }

  /**
   * A call failed. With the document's text at hand, a new engine highlighter is made and given
   * it, then the visible lines are asked again; a few failures in a row leave the plain text.
   */
  #lost(): void {
    if (this.#disposed || this.#broken) return;
    this.#broken = true;
    const source = this.#source;
    if (!source || this.#rebuilds >= maxRebuilds) return;
    this.#rebuilds++;
    const old = this.#native;
    this.#native = undefined;
    void Promise.resolve(old?.free()).catch(() => undefined);
    this.#ready = this.#open(this.#language, this.#options);
    this.#ready.catch(() => undefined);
    this.#broken = false;
    this.setText(source());
  }

  #scheduleFetch(): void {
    if (this.#disposed) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        void this.#fetch();
      },
      this.#firstFetch ? 0 : this.#delay,
    );
  }

  async #fetch(): Promise<void> {
    const native = this.#native;
    const { start, end } = this.#visible;
    if (!native || this.#disposed) return;
    const key = `${start}:${end}:${this.#generation}`;
    this.#requested = key;
    this.#firstFetch = false;
    try {
      await this.#queue;
      if (this.#disposed || key !== this.#requested) return;
      const tokens = await native.tokens(start, end);
      if (this.#disposed || key !== this.#requested) return;
      this.#stale = false;
      this.#rebuilds = 0;
      for (const [index, line] of tokens.entries()) this.#cache[start + index] = line.map(toToken);
      for (const listener of this.#listeners) listener();
    } catch {
      // The engine lost this highlighter: rebuild it from the text (a few times at most); the
      // colours already drawn stay meanwhile.
      this.#stale = false;
      this.#lost();
    }
  }

  #scheduleAdvance(): void {
    if (this.#disposed || !this.#native || this.#idle !== undefined) return;
    const run = () => {
      this.#idle = undefined;
      const native = this.#native;
      if (!native || this.#disposed) return;
      void this.#queue
        .then(() => native.advance(200))
        .then((more) => {
          if (this.#disposed) return;
          if (more) this.#scheduleAdvance();
          else {
            this.#stale = true;
            this.#scheduleFetch();
          }
        })
        .catch(() => this.#lost());
    };
    this.#idle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(run, { timeout: 500 })
        : (setTimeout(run, 60) as unknown as number);
  }
}

function toToken(token: CodeToken): Token {
  return { kind: "plain", text: token.text, light: token.light, dark: token.dark };
}
