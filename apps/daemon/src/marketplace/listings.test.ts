import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedCatalog } from "@ace/marketplace";
import { keySetOf, testKey } from "@ace/marketplace/testing";
import { afterEach, expect, test } from "vitest";
import { refreshSource } from "./listings.ts";
import { MarketStore, type StoredSource } from "./store.ts";
import { Trust } from "./trust.ts";

/* A catalog read that is slow never undoes what the person changed about it while it ran. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const catalog: StoredSource = {
  id: "git:catalog",
  kind: "git",
  address: "https://example.com/catalog.git",
  enabled: true,
};

type Read = { commit: string; catalog: ParsedCatalog };
const empty: ParsedCatalog = { name: "Catalog", entries: [], problems: [] };

/** A git catalog whose read waits until the test lets it finish. */
function slowGit() {
  let finish: ((read: Read) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const git = {
    read: () =>
      new Promise<Read>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  };
  return {
    git,
    finish: (parsed: ParsedCatalog = empty) => finish?.({ commit: "c1", catalog: parsed }),
    fail: (error: Error) => fail?.(error),
  };
}

async function setUp() {
  const root = await mkdtemp(join(tmpdir(), "ace-listings-"));
  roots.push(root);
  const store = await MarketStore.open(root);
  store.saveSource(catalog);
  const keys = keySetOf(testKey("root"));
  const slow = slowGit();
  const deps = {
    store,
    http: undefined,
    git: slow.git,
    keys,
    trust: new Trust(store, keys),
    now: () => 1_000,
  };
  return { store, deps, slow };
}

test("a catalog turned off while its read runs stays off after the read lands", async () => {
  const { store, deps, slow } = await setUp();
  const reading = refreshSource(deps, catalog);
  store.saveSource({ ...catalog, enabled: false });
  slow.finish();
  await reading;

  expect(store.source(catalog.id)).toMatchObject({ enabled: false, commit: "c1", readAt: 1_000 });
});

test("a catalog turned off while its read fails stays off, with the failure noted", async () => {
  const { store, deps, slow } = await setUp();
  const reading = refreshSource(deps, catalog);
  store.saveSource({ ...catalog, enabled: false });
  slow.fail(new Error("The catalog couldn't be reached"));
  await reading;

  expect(store.source(catalog.id)).toMatchObject({
    enabled: false,
    problem: "The catalog couldn't be reached",
  });
});

test("a catalog removed while its read runs isn't brought back", async () => {
  const { store, deps, slow } = await setUp();
  const reading = refreshSource(deps, catalog);
  await store.removeSource(catalog.id);
  slow.finish({
    ...empty,
    entries: [
      {
        type: "spade-plugin",
        name: "mail-tools",
        source: ".",
        title: "Mail tools",
        description: "",
        keywords: [],
      },
    ],
  });
  await reading;

  expect(store.source(catalog.id)).toBeUndefined();
  expect((await store.listing(catalog.id)).entries).toEqual([]);
});
