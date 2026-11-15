import type { ClientApi } from "@ace/client";
import { MarkitRenderer, type MarkitOptions } from "@ace/markit-web/react";
import { contentHash, LruCache } from "@ace/ui-core";

/*
 * A finished thread answer stays drawn when its row unmounts (a thread switch, a row scrolled
 * out of the virtualised transcript): its markit renderer and the element it drew into are kept,
 * and the same answer mounting again in the same context gets them back whole. The row's first
 * frame is the rendered answer at its rendered height, with no worker job. Nothing is re-rendered
 * or re-sanitised: what comes back is exactly what markit drew.
 *
 * What may come back is scoped tightly:
 * - each client (one connection to one daemon) owns its own kept answers, so nothing drawn
 *   for one daemon or account is shown for another;
 * - an entry is one item of one thread, reused only under the exact context that drew it
 *   (`answerContext`: flavour, colour scheme, the item's cwd, the thread's checkout and the
 *   text); a mount under any other context drops it and draws afresh;
 * - a thread the client no longer holds (deleted, evicted, or the client closed) loses its
 *   entries (`sweep`);
 * - an answer whose cost its text doesn't bound (images, video, diagrams) is not kept;
 * - streaming answers and prose outside a thread item are never kept.
 * While detached an entry calls no view: its hooks are let go, so it keeps no client, store or
 * workspace alive.
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
  element: HTMLElement;
  renderer: MarkitRenderer;
  /** The mounted view's hooks; a view taking the answer points this at its own. */
  hooks: { current: RendererHooks };
}

/** Where an answer is drawn: the one item of one thread it belongs to. */
export interface AnswerScope {
  threadId: string;
  itemId: string;
}

interface Entry {
  answer: KeptAnswer;
  key: string;
  threadId: string;
  context: string;
  weight: number;
}

/** The context that changes markit's output for an answer; a different one never reuses it. */
export function answerContext(input: {
  flavor: string;
  scheme: string;
  cwd: string | undefined;
  root: string | undefined;
  text: string;
}): string {
  return [input.flavor, input.scheme, input.cwd ?? "", input.root ?? "", input.text].join("\u0000");
}

const scopeKey = (scope: AnswerScope) => `${scope.threadId}\u0000${scope.itemId}`;

/**
 * ADR 0056's bound for drawn answers kept off the page: 200 answers and 12 MB. Weighed as what is
 * retained: the text twice (markit's copy and the worker's parsed stream, UTF-16), 256 bytes per
 * DOM node markit drew, and 16 KB for each renderer and its listeners.
 */
export const keptBounds = { entries: 200, bytes: 12 * 1024 * 1024 };
export const rendererOverhead = 16 * 1024;
export function keptWeight(text: string, element: Element): number {
  return text.length * 2 * 2 + element.getElementsByTagName("*").length * 256 + rendererOverhead;
}

/** Drawn media whose bytes the text doesn't bound: such an answer is drawn again, never kept. */
const unbounded = "img, picture, video, .mk-diagram";

const hookNames = ["onLink", "onReference", "resolveImage", "renderDiagram", "onError"] as const;
/** What a kept answer calls while no view holds it: nothing. */
const detached: RendererHooks = {};

/** A renderer drawing into a fresh element, calling whichever view holds it now. */
export function createKeptAnswer(setup: RendererSetup, hooks: RendererHooks): KeptAnswer {
  const element = document.createElement("div");
  const holder = { current: hooks };
  const options: MarkitOptions = { ...setup };
  // Read when used, so the view mounted now answers a click, never the one that drew it.
  for (const name of hookNames)
    Object.defineProperty(options, name, { enumerable: true, get: () => holder.current[name] });
  return { element, renderer: new MarkitRenderer(element, options), hooks: holder };
}

export function disposeKeptAnswer(answer: KeptAnswer): void {
  answer.hooks.current = detached;
  answer.renderer.destroy();
  answer.element.remove();
}

/** Heights kept per client, for answers drawn before: a fixed bound, each record under 300 bytes. */
export const heightEntries = 2_000;

/** How a client's kept answers are bounded, and who hears when they first hold something. */
export interface KeptOptions {
  bounds?: { entries: number; bytes: number };
  heightEntries?: number;
  /** Called whenever a drawing or a height is retained (the shell registers the cache then). */
  retained?: () => void;
}

/** One client's kept answers. `holds(threadId)`: the client still has that thread. */
export class KeptAnswers {
  readonly #cache: LruCache<string, Entry>;
  readonly #holds: (threadId: string) => boolean;
  readonly #retained: () => void;
  /** Each thread's record keys (a drawing, a height or both), so a thread's records go together. */
  readonly #byThread = new Map<string, Set<string>>();
  /**
   * The height each answer was last drawn at, for a mount that must draw again: under a short
   * fingerprint of the context that drew it, never the text itself.
   */
  readonly #heights = new Map<string, { threadId: string; fingerprint: string; height: number }>();
  readonly #heightEntries: number;

  constructor(holds: (threadId: string) => boolean, options: KeptOptions = {}) {
    const bounds = options.bounds ?? keptBounds;
    this.#holds = holds;
    this.#retained = options.retained ?? (() => {});
    this.#cache = new LruCache<string, Entry>({
      maxEntries: bounds.entries,
      maxWeight: bounds.bytes,
      weigh: (entry) => entry.weight,
      dispose: (entry) => {
        disposeKeptAnswer(entry.answer);
        this.#unindex(entry.threadId, entry.key);
      },
    });
    this.#heightEntries = options.heightEntries ?? heightEntries;
  }

  /** Drawings kept. */
  get size(): number {
    return this.#cache.size;
  }
  /** Drawings and heights held, of any thread. */
  get records(): number {
    return this.#cache.size + this.#heights.size;
  }
  get bytes(): number {
    return this.#cache.weight;
  }

  /** Whether a drawing of this answer under exactly `context` is kept. */
  has(scope: AnswerScope, context: string): boolean {
    return this.#holds(scope.threadId) && this.#cache.get(scopeKey(scope))?.context === context;
  }

  /** The kept drawing of this answer under `context`, now the caller's. Any other is dropped. */
  take(scope: AnswerScope, context: string): KeptAnswer | undefined {
    if (!this.#holds(scope.threadId)) {
      this.purgeThread(scope.threadId);
      return undefined;
    }
    const key = scopeKey(scope);
    const entry = this.#cache.take(key);
    if (!entry) return undefined;
    this.#unindex(entry.threadId, key);
    if (entry.context === context) return entry.answer;
    disposeKeptAnswer(entry.answer);
    return undefined;
  }

  /**
   * Keeps a finished drawing made under `context`, unless the client no longer holds its thread
   * or what it shows isn't bounded by its text. A held thread's answer leaves its height.
   */
  keep(scope: AnswerScope, context: string, answer: KeptAnswer, height: number): void {
    const key = scopeKey(scope);
    answer.element.remove();
    answer.hooks.current = detached;
    if (!this.#holds(scope.threadId)) {
      disposeKeptAnswer(answer);
      this.purgeThread(scope.threadId);
      return;
    }
    this.#remember(scope.threadId, key, context, height);
    if (answer.element.querySelector(unbounded)) disposeKeptAnswer(answer);
    else {
      const weight = keptWeight(context, answer.element);
      this.#cache.set(key, { answer, key, threadId: scope.threadId, context, weight });
      if (this.#cache.has(key)) this.#index(scope.threadId, key);
    }
  }

  /** The height this answer was last drawn at under `context`, if known. */
  height(scope: AnswerScope, context: string): number | undefined {
    const known = this.#heights.get(scopeKey(scope));
    return known?.fingerprint === contentHash(context) ? known.height : undefined;
  }

  /** Drops the drawings and heights of every thread the client no longer holds. */
  sweep(): void {
    for (const threadId of this.#byThread.keys())
      if (!this.#holds(threadId)) this.purgeThread(threadId);
  }

  /** Drops every kept drawing and height of one thread. */
  purgeThread(threadId: string): void {
    const keys = this.#byThread.get(threadId);
    this.#byThread.delete(threadId);
    for (const key of keys ?? []) {
      this.#heights.delete(key);
      const entry = this.#cache.take(key);
      if (entry) disposeKeptAnswer(entry.answer);
    }
  }

  clear(): void {
    this.#cache.clear();
    this.#byThread.clear();
    this.#heights.clear();
  }

  #index(threadId: string, key: string): void {
    let keys = this.#byThread.get(threadId);
    if (!keys) this.#byThread.set(threadId, (keys = new Set()));
    keys.add(key);
    this.#retained();
  }

  /** Forgets `key` for its thread once neither a drawing nor a height is kept under it. */
  #unindex(threadId: string, key: string): void {
    if (this.#cache.has(key) || this.#heights.has(key)) return;
    const keys = this.#byThread.get(threadId);
    keys?.delete(key);
    if (keys?.size === 0) this.#byThread.delete(threadId);
  }

  #remember(threadId: string, key: string, context: string, height: number): void {
    if (height <= 0) return;
    this.#heights.delete(key);
    this.#heights.set(key, { threadId, fingerprint: contentHash(context), height });
    this.#index(threadId, key);
    if (this.#heights.size <= this.#heightEntries) return;
    const oldest = this.#heights.entries().next().value;
    if (!oldest) return;
    this.#heights.delete(oldest[0]);
    this.#unindex(oldest[1].threadId, oldest[0]);
  }
}

/*
 * The shell: each client's kept answers live and die with it. A client that closed holds no
 * thread (`peekThread` answers nothing), so its records go at the next sweep. Every view runs
 * one for every client as it mounts and as it unmounts (`sweepKeptAnswers`). A client's cache
 * is swept while it holds any record: retaining one registers it again.
 */
const owned = new WeakMap<ClientApi, KeptAnswers>();
const live = new Set<KeptAnswers>();

/** A thread the client still holds and hasn't deleted; asking never keeps it cached. */
function holdsThread(client: ClientApi, threadId: string): boolean {
  const store = client.peekThread?.(threadId);
  return store !== undefined && store.thread?.deletedAt === undefined;
}

export function keptAnswersFor(client: ClientApi): KeptAnswers {
  let kept = owned.get(client);
  if (!kept) {
    const created = new KeptAnswers((threadId) => holdsThread(client, threadId), {
      retained: () => live.add(created),
    });
    kept = created;
    owned.set(client, kept);
  }
  return kept;
}

/** Sweeps every client's kept answers, forgetting those that hold nothing any more. */
export function sweepKeptAnswers(): void {
  for (const kept of live) {
    kept.sweep();
    if (kept.records === 0) live.delete(kept);
  }
}
