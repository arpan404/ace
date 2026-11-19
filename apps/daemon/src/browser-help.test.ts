import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { BrowserHelp } from "./browser-help.ts";
import type { Engine } from "./engine/index.ts";
import { Store } from "./store.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Any use of the engine or the browser fails the test: the hot path must not reach them. */
const untouchable = new Proxy({} as Engine, {
  get() {
    throw new Error("the engine was used");
  },
});

function helpWithOneOpenRequest() {
  const home = mkdtempSync(join(tmpdir(), "ace-browser-help-"));
  homes.push(home);
  const store = new Store(join(home, "events.sqlite"));
  const deps = {
    store,
    engine: () => untouchable,
    tab: () => {
      throw new Error("the browser was asked");
    },
    id: () => "id",
    schedule: () => () => {},
  };
  // A request open on another thread, as a restart finds it (the first daemon made the table).
  const before = new BrowserHelp(deps);
  before.close();
  store.atomic((db) =>
    db
      .prepare("INSERT INTO browser_help_pending VALUES (?,?,?,?,?)")
      .run("ask-1", "thread-with-help", "key-1", "tab-1", "Sign in"),
  );
  const help = new BrowserHelp(deps);
  let transactions = 0;
  const atomic = store.atomic.bind(store);
  store.atomic = (run) => {
    transactions++;
    return atomic(run);
  };
  return { help, store, transactions: () => transactions };
}

it("an event on a thread with no browser-help request opens no transaction and reads no rows", async () => {
  const { help, store, transactions } = helpWithOneOpenRequest();
  const quiet = ThreadId.parse("thread-without-help");
  help.sweep(quiet);
  help.withdrawIdle(quiet, "agent-1");
  expect(transactions()).toBe(0);
  await store.close();
});
