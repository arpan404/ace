import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { afterEach, expect, it } from "vitest";
import { MarketStore, type StoredInstall } from "./store.ts";

/*
 * A bot package can make several bots, one install each (ADR 0200 §3.9). A home from before kept
 * one row per package name: it opens with that row as its bot's install, and a second bot from
 * the same package gets its own.
 */

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const bot = (target: string, version: string): StoredInstall => ({
  source: "market",
  type: "spade-bot",
  name: "flight-watcher",
  title: "Flight watcher",
  version,
  hash: "a".repeat(64),
  acceptedAt: 1,
  state: "on",
  files: [],
  description: "",
  target,
  linked: true,
});

it("opens a home with one bot row per package as each bot's own install, then keeps a second bot", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ace-bot-installs-"));
  folders.push(folder);
  const old = new DatabaseSync(join(folder, "registry.sqlite"));
  old.exec(
    "CREATE TABLE installs (type TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (type, name))",
  );
  old
    .prepare("INSERT INTO installs (type, name, data) VALUES (?, ?, ?)")
    .run("spade-bot", "flight-watcher", JSON.stringify(bot("bot_1", "1.0.0")));
  old.close();

  const store = await MarketStore.open(folder);
  expect(store.install("spade-bot", "flight-watcher", "bot_1")).toMatchObject({ version: "1.0.0" });
  store.saveInstall(bot("bot_2", "2.0.0"));
  expect(store.botInstalls("flight-watcher").map((each) => each.target)).toEqual([
    "bot_1",
    "bot_2",
  ]);
  store.removeInstallKeepingProvenance(bot("bot_1", "1.0.0"));
  expect(store.installs().map((each) => each.target)).toEqual(["bot_2"]);
  store.close();

  // Opened again, nothing is moved twice.
  const again = await MarketStore.open(folder);
  expect(again.installs().map((each) => each.target)).toEqual(["bot_2"]);
  again.close();
});
