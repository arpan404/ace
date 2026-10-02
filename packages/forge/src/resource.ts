import { z } from "zod";
import type { GhApi, Page } from "./http.ts";
import type { ReadBudget } from "./read-budget.ts";
import { ForgeError } from "./errors.ts";

import { CollectionVersions } from "./incremental.ts";
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
export class ResourceReader<T extends { id: number }, U> {
  readonly #decoder: PageDecoder<T[]>;
  readonly #project: (item: T) => U;
  readonly #same: (a: T, b: T) => boolean;
  readonly #records = new Map<number, { source: T; item: U }>();
  readonly #identity: (item: U) => string;
  readonly #projected = new WeakMap<Page, U[]>();
  readonly versions = new CollectionVersions<U>();
  #pages: Page[] = [];
  #last: Resource<U> | undefined;
  constructor(
    schema: z.ZodType<T[]>,
    project: (item: T) => U,
    identity: (item: U) => string,
    same: (a: T, b: T) => boolean,
  ) {
    this.#decoder = new PageDecoder(schema);
    this.#project = project;
    this.#identity = identity;
    this.#same = same;
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
    const decoded = pages.map((page) => this.#decoder.read(page));
    const oldPages = new Set(this.#pages);
    const staged = new Map<number, { source: T; item: U }>();
    const projected = pages.map((page, position) => {
      const source = decoded[position];
      if (!source) throw new ForgeError("invalid_data");
      const known = this.#projected.get(page);
      if (known) {
        if (!oldPages.has(page))
          source.forEach((entry, index) => {
            const item = known[index];
            if (item !== undefined) staged.set(entry.id, { source: entry, item });
          });
        return known;
      }
      const items = immutable(
        source.map((entry) => {
          const previous = staged.get(entry.id) ?? this.#records.get(entry.id);
          const item =
            previous && this.#same(previous.source, entry) ? previous.item : this.#project(entry);
          staged.set(entry.id, { source: entry, item });
          return item;
        }),
      );
      this.#projected.set(page, items);
      return items;
    });
    if (projected.reduce((count, items) => count + items.length, 0) > 2_000)
      throw new ForgeError("limit");
    const removed = new Map<string, U>();
    const upsert = new Map<string, U>();
    const currentPages = new Set(pages);
    for (const page of this.#pages)
      if (!currentPages.has(page))
        for (const item of this.#projected.get(page) ?? []) removed.set(this.#identity(item), item);
    for (const page of pages)
      if (!oldPages.has(page))
        for (const item of this.#projected.get(page) ?? []) upsert.set(this.#identity(item), item);
    for (const [key, item] of upsert) {
      if (removed.get(key) === item) upsert.delete(key);
      removed.delete(key);
    }
    for (const page of this.#pages)
      if (!currentPages.has(page)) {
        const source = this.#decoder.read(page);
        const projection = this.#projected.get(page) ?? [];
        for (let index = 0; index < source.length; index++) {
          const entry = source[index];
          const item = projection[index];
          if (entry && item && removed.has(this.#identity(item))) this.#records.delete(entry.id);
        }
      }
    for (const [id, record] of staged) this.#records.set(id, record);
    const items = this.versions.retain(this.#last?.items ?? [], projected.flat(), {
      upsert: [...upsert.values()],
      removed: [...removed.values()],
    });
    this.#pages = pages;
    this.#last = immutable({ items, raw: pages.map((page) => page.body) });
    return this.#last;
  }
}
