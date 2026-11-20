import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { reconcileBots } from "./arrived-bots.ts";
import type { LinkedBot, SpadePort } from "./install.ts";
import { MarketStore } from "./store.ts";

/*
 * A linked bot the Marketplace doesn't know of is adopted from its source's bytes; one whose
 * package no source holds (a template Spade ships, a local package) is never fetched for.
 */

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

it("never fetches for a template's bot or a local package's, only for a market package's", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ace-arrived-"));
  folders.push(folder);
  const store = await MarketStore.open(folder);
  const linked: LinkedBot[] = [
    { id: "a1", package: { source: "spade", name: "inbox", version: "1.0.0", hash: "h1" } },
    {
      id: "a2",
      package: { source: "local", name: "local/fare-watcher", version: "local", hash: "h2" },
    },
    {
      id: "a3",
      package: { source: "market", name: "flight-watcher", version: "1.0.0", hash: "h3" },
    },
  ];
  const port: Pick<SpadePort, "ready" | "bots"> = {
    ready: () => true,
    bots: async () => ({ ids: new Set(linked.map((bot) => bot.id)), linked }),
  };
  const fetched: string[] = [];
  const changed = await reconcileBots({
    store,
    spade: port as SpadePort,
    now: () => 1,
    fetch: async (source: string, name: string, version: string) => {
      fetched.push(`${source}/${name}@${version}`);
      throw new Error("offline");
    },
  });
  expect(fetched).toEqual(["market/flight-watcher@1.0.0"]);
  expect(changed).toBe(false);
  expect(store.install("spade-bot", "inbox")).toBeUndefined();
  store.close();
});
