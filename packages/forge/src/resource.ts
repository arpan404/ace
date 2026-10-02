import { z } from "zod";
import type { GhApi, Page } from "./http.ts";
import type { ReadBudget } from "./read-budget.ts";
import { ForgeError } from "./errors.ts";

import { immutable } from "./immutable.ts";

/** Non-owning cache: page lifetimes are bounded by transport LRU and current readers. */
export class PageDecoder<T> {
  readonly #schema: z.ZodType<T>;
  readonly #decoded = new WeakMap<Page, T>();
  constructor(schema: z.ZodType<T>) {
    this.#schema = schema;
  }
  read(page: Page): T {
    const known = this.#decoded.get(page);
    if (known !== undefined) return known;
    const result = this.#schema.safeParse(page.body);
    if (!result.success) throw new ForgeError("invalid_data");
    const decoded = immutable(result.data);
    this.#decoded.set(page, decoded);
    return decoded;
  }
}
export type Resource<T> = { items: T[]; raw: unknown[] };
/** Retains one current connection, not a map of PR histories. */
export class ResourceReader<T, U> {
  readonly #decoder: PageDecoder<T[]>;
  readonly #project: (items: T[]) => U[];
  #pages: Page[] = [];
  #last: Resource<U> | undefined;
  constructor(schema: z.ZodType<T[]>, project: (items: T[]) => U[]) {
    this.#decoder = new PageDecoder(schema);
    this.#project = project;
  }
  async read(
    api: GhApi,
    path: string,
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<Resource<U>> {
    const pages = await api.pages(path, signal, budget);
    if (
      this.#last &&
      pages.length === this.#pages.length &&
      pages.every((page, index) => page === this.#pages[index])
    )
      return this.#last;
    const source = pages.flatMap((page) => this.#decoder.read(page));
    if (source.length > 2_000) throw new ForgeError("limit");
    const items = this.#project(source);
    this.#pages = pages;
    this.#last = immutable({ items, raw: pages.map((page) => page.body) });
    return this.#last;
  }
}
