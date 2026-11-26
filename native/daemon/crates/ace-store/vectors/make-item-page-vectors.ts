// SPDX-License-Identifier: Apache-2.0

/*
 * Produces `item-page.json`, the byte fixtures T4's bounded item page is proved against.
 *
 *   bun native/daemon/crates/ace-store/vectors/make-item-page-vectors.ts
 *
 * The TypeScript `boundedItemPage` over a scripted `ItemPageSource`: each case fixes what the
 * store page answers (a page, or the capacity error), the newest item the page could not start
 * with, and what is older. The expected text is what the TypeScript returns after dropping raw
 * payloads, clipping long strings or summarising an item that cannot fit, plus the exact reads
 * it made. `clipItem` has its own cases.
 */

import { join } from "node:path";
import { Item, type Item as WireItem } from "@ace/protocol";
import {
  boundedItemPage,
  type ItemPageSource,
} from "../../../../../apps/daemon/src/bounded-item-page.ts";
import { clipItem } from "../../../../../apps/daemon/src/item-clip.ts";
import { ItemPageCapacityExceeded } from "../../../../../apps/daemon/src/item-page-capacity.ts";
import { writeVectors } from "../../../vectors/vectors-io.ts";

const json = (value: unknown): string => JSON.stringify(value);

const message = (id: string, text: string, parts = 1): WireItem =>
  Item.parse({
    id,
    agentId: "root",
    type: "message",
    role: "assistant",
    createdAt: 1,
    parts: Array.from({ length: parts }, () => ({ type: "text", text })),
  });

const shell = (id: string, command: string): WireItem =>
  Item.parse({
    id,
    agentId: "root",
    type: "tool_call",
    createdAt: 1,
    call: {
      id,
      agentId: "root",
      kind: "shell",
      title: "run",
      status: "succeeded",
      detail: { kind: "shell", command },
      startedAt: 1,
      raw: [{ type: "message_stop", data: { blob: "A".repeat(4096) } }],
    },
  });

type Response =
  | {
      kind: "page";
      items: WireItem[];
      itemSeqs?: Record<string, number>;
      itemsBefore: number | null;
    }
  | { kind: "capacity" };

type Call = { call: string; before: number; limit?: number; budget?: number };

function run(
  name: string,
  script: {
    thread?: string;
    before: number;
    limit: number;
    byteLimit: number;
    pages: Response[];
    newest?: { before: number; item: WireItem; seq: number }[];
    hasBefore?: Record<string, boolean>;
  },
): {
  name: string;
  before: number;
  limit: number;
  byteLimit: number;
  pages: { kind: string; items?: string[]; itemSeqs?: string; itemsBefore?: number | null }[];
  newest: { before: number; item: string; seq: number }[];
  hasBefore: Record<string, boolean>;
  calls: Call[];
  expected: string;
} {
  const calls: Call[] = [];
  const pages = [...script.pages];
  const newest = new Map((script.newest ?? []).map((entry) => [String(entry.before), entry]));
  const has = script.hasBefore ?? {};
  const source: ItemPageSource = {
    page(before, limit, budget) {
      calls.push({ call: "page", before, limit, budget });
      const next = pages.shift();
      if (!next) throw new Error(`${name}: unscripted page`);
      if (next.kind === "capacity") throw new ItemPageCapacityExceeded();
      return { items: next.items, itemSeqs: next.itemSeqs ?? {}, itemsBefore: next.itemsBefore };
    },
    newestBefore(before) {
      calls.push({ call: "newestBefore", before });
      const found = newest.get(String(before));
      return found ? { item: found.item, seq: found.seq } : undefined;
    },
    hasItemBefore(before) {
      calls.push({ call: "hasItemBefore", before });
      return has[String(before)] ?? false;
    },
  };
  const result = boundedItemPage(
    source,
    (script.thread ?? "t") as never,
    script.before,
    script.limit,
    script.byteLimit,
  );
  return {
    name,
    before: script.before,
    limit: script.limit,
    byteLimit: script.byteLimit,
    pages: script.pages.map((response) =>
      response.kind === "capacity"
        ? { kind: "capacity" }
        : {
            kind: "page",
            items: response.items.map(json),
            itemSeqs: json(response.itemSeqs ?? {}),
            itemsBefore: response.itemsBefore,
          },
    ),
    newest: (script.newest ?? []).map((entry) => ({
      before: entry.before,
      item: json(entry.item),
      seq: entry.seq,
    })),
    hasBefore: has,
    calls,
    expected: json(result),
  };
}

const cases = [
  run("a page that fits is the source's page", {
    before: 100,
    limit: 10,
    byteLimit: 64 * 1024,
    pages: [
      {
        kind: "page",
        items: [message("m2", "two"), message("m1", "one")],
        itemSeqs: { m2: 2, m1: 1 },
        itemsBefore: 1,
      },
    ],
    hasBefore: { "1": true },
  }),
  run("an oversized tool call loses its raw payloads and pages on", {
    before: 100,
    limit: 10,
    byteLimit: 8 * 1024,
    pages: [
      { kind: "capacity" },
      { kind: "page", items: [message("m1", "one")], itemSeqs: { m1: 1 }, itemsBefore: 1 },
    ],
    newest: [{ before: 100, item: shell("t2", "ls -la"), seq: 50 }],
    hasBefore: { "50": true, "1": true },
  }),
  run("a huge text message is clipped to the page", {
    before: 100,
    limit: 10,
    byteLimit: 4 * 1024,
    pages: [{ kind: "capacity" }, { kind: "page", items: [], itemsBefore: null }],
    newest: [{ before: 100, item: message("big", "line\n".repeat(4000)), seq: 60 }],
    hasBefore: { "60": false },
  }),
  run("an item that cannot fit even clipped is its summary", {
    before: 100,
    limit: 10,
    byteLimit: 8 * 1024,
    pages: [
      { kind: "capacity" },
      {
        kind: "page",
        items: [message("old", "older")],
        itemSeqs: { old: 1 },
        itemsBefore: null,
      },
    ],
    // Many short strings: nothing is long enough to clip, so the item is summarised.
    newest: [{ before: 100, item: message("many", "x".repeat(200), 200), seq: 70 }],
    hasBefore: { "70": false },
  }),
  run("a page that spends its budget stops before the envelope", {
    before: 100,
    limit: 3,
    byteLimit: 8 * 1024,
    pages: [{ kind: "capacity" }, { kind: "capacity" }],
    newest: [{ before: 100, item: shell("t2", "ls"), seq: 50 }],
    hasBefore: { "50": true },
  }),
  run("limit one stops at the newest item", {
    before: 100,
    limit: 1,
    byteLimit: 8 * 1024,
    pages: [{ kind: "capacity" }],
    newest: [{ before: 100, item: shell("t1", "pwd"), seq: 40 }],
    hasBefore: { "40": true },
  }),
  run("nothing older makes itemsBefore null", {
    before: 100,
    limit: 2,
    byteLimit: 8 * 1024,
    pages: [
      { kind: "page", items: [message("m1", "one")], itemSeqs: { m1: 1 }, itemsBefore: null },
    ],
  }),
];

const clips = [
  { name: "a short item is not clipped", item: message("m1", "short"), maxBytes: 64 * 1024 },
  {
    name: "a long message is cut with its count",
    item: message("m2", "a".repeat(2000)),
    maxBytes: 600,
  },
  {
    name: "a cut never splits a surrogate pair",
    item: message("m3", "😀".repeat(500)),
    maxBytes: 1500,
  },
  {
    name: "an item with only short strings is not clipped",
    item: message("m4", "x".repeat(200), 200),
    maxBytes: 600,
  },
].map(({ name, item, maxBytes }) => ({
  name,
  item: json(item),
  maxBytes,
  expected: (() => {
    const clipped = clipItem(item, maxBytes);
    return clipped === undefined ? null : json(clipped);
  })(),
}));

writeVectors(join(import.meta.dir, "item-page.json"), { pages: cases, clips });
