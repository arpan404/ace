import { MarkitRenderer, type MarkitOptions } from "@ace/markit-web/react";
import { BoundedLru, type LruBounds } from "./bounded-lru.ts";

/*
 * Finished prose stays drawn when its row unmounts (a thread switch, a row scrolled out of the
 * virtualised transcript): its markit renderer and the element it drew into are kept, and the
 * same text mounting again gets them back whole. The row's first frame is the rendered answer,
 * at its rendered height, with its code views, images and diagrams in place and no worker job.
 * Nothing is re-rendered or re-sanitised: what comes back is exactly what markit drew under the
 * same flavour. Streaming prose is never kept; it draws live.
 */

/** What the view rendering a kept answer hands its renderer (read at call time). */
export type RendererHooks = Pick<
  MarkitOptions,
  "onLink" | "onReference" | "resolveImage" | "renderDiagram" | "onError"
>;

/** How a renderer is built: everything fixed for its life. */
export type RendererSetup = Pick<
  MarkitOptions,
  "workerURL" | "worker" | "wasm" | "code" | "flavor"
>;

/** One drawn answer, out of the page while its row is gone. */
export interface KeptAnswer {
  text: string;
  element: HTMLElement;
  renderer: MarkitRenderer;
  /** The mounted view's hooks; a view taking the answer points this at its own. */
  hooks: { current: RendererHooks };
}

/**
 * ADR 0056's bound for drawn prose kept off the page. Weighed as the text's UTF-16 bytes times
 * four: the DOM markit drew (markup, code rows) and the worker's copy of the parsed source.
 */
export const keptBounds: LruBounds = { entries: 200, bytes: 12 * 1024 * 1024 };
export const keptWeight = (text: string) => text.length * 2 * 4;

const hookNames = ["onLink", "onReference", "resolveImage", "renderDiagram", "onError"] as const;

/** A renderer drawing into a fresh element, calling whichever view holds it now. */
export function createKeptAnswer(setup: RendererSetup, hooks: RendererHooks): KeptAnswer {
  const element = document.createElement("div");
  const holder = { current: hooks };
  const options: MarkitOptions = { ...setup };
  // Read when used, so the view mounted now answers a click, never the one that drew it.
  for (const name of hookNames)
    Object.defineProperty(options, name, { enumerable: true, get: () => holder.current[name] });
  return { text: "", element, renderer: new MarkitRenderer(element, options), hooks: holder };
}

export function disposeKeptAnswer(answer: KeptAnswer): void {
  answer.renderer.destroy();
  answer.element.remove();
}

/** The page's kept answers. */
export class KeptAnswers {
  readonly #cache: BoundedLru<KeptAnswer>;
  /** Heights of answers drawn before, for those no longer kept, so their row keeps its size. */
  readonly #heights = new Map<string, { length: number; height: number }>();
  readonly #heightEntries: number;

  constructor(bounds: LruBounds = keptBounds, heightEntries = 2_000) {
    this.#cache = new BoundedLru(bounds, disposeKeptAnswer);
    this.#heightEntries = heightEntries;
  }

  get size(): number {
    return this.#cache.size;
  }
  get bytes(): number {
    return this.#cache.bytes;
  }

  /** Whether `text` under `key` is kept, drawn finished. */
  has(key: string, text: string): boolean {
    return this.#cache.has(key, (answer) => answer.text === text);
  }

  /** The kept drawing of `text` under `key`, now the caller's. A stale one is dropped. */
  take(key: string, text: string): KeptAnswer | undefined {
    const answer = this.#cache.take(key);
    if (!answer || answer.text === text) return answer;
    disposeKeptAnswer(answer);
    return undefined;
  }

  /** Keeps a finished drawing of `answer.text` and remembers its height. */
  keep(key: string, answer: KeptAnswer, height: number): void {
    answer.element.remove();
    this.remember(key, answer.text, height);
    this.#cache.put(key, answer, keptWeight(answer.text));
  }

  /** The height `text` under `key` was last drawn at, if known. */
  height(key: string, text: string): number | undefined {
    const known = this.#heights.get(key);
    return known && known.length === text.length ? known.height : undefined;
  }

  remember(key: string, text: string, height: number): void {
    if (height <= 0) return;
    this.#heights.delete(key);
    this.#heights.set(key, { length: text.length, height });
    if (this.#heights.size > this.#heightEntries) {
      const oldest = this.#heights.keys().next().value;
      if (oldest !== undefined) this.#heights.delete(oldest);
    }
  }

  clear(): void {
    this.#cache.clear();
    this.#heights.clear();
  }
}

/** The key for one stream's prose: what changes markit's output is part of it. */
export const keptKey = (flavor: string, scheme: string, stream: string) =>
  `${flavor}\u0000${scheme}\u0000${stream}`;

/** The page's one set of kept answers (the shell around the bounded cache). */
export const pageAnswers = new KeptAnswers();
