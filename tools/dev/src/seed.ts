#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "@ace/daemon";
import {
  FakeDaemon,
  ScenarioPlayer,
  coldStartReplay,
  failingSubagent,
  flakyCheckout,
  homeList,
  longHistory,
} from "@ace/fake-daemon";
import { ThreadId, type EventPayload } from "@ace/protocol";

/**
 * `ACE_DEV_SEED=1`: copies the fake daemon's demo threads into the development daemon's
 * store, so the real daemon starts with realistic history. Scenario facts are folded by
 * `@ace/core` exactly as in the daemon; the resulting events are replayed into the store
 * under one development workspace. Runs before the daemon starts (it takes the store's
 * lock) and only into an empty store, so it never mixes with real work.
 */
const home = process.env.ACE_HOME;
if (!home || !home.includes(".ace-dev")) throw new Error("Seeding only writes to a .ace-dev home");
mkdirSync(home, { recursive: true, mode: 0o700 });

const store = new Store(join(home, "events.sqlite"));
try {
  if (store.listThreads().length > 0) {
    console.log("[seed] the development store already has threads; leaving it alone");
  } else {
    const workspace = store.createWorkspace(resolve(import.meta.dirname, "../../.."), "ace (demo)");
    let agoMs = 0;
    const fake = new FakeDaemon({ clock: () => Date.now() - agoMs });
    new ScenarioPlayer(fake, longHistory(120)).runUntilBlocked();
    for (const aged of homeList()) {
      agoMs = aged.agoMs;
      new ScenarioPlayer(fake, aged.scenario).runUntilBlocked();
    }
    agoMs = 0;
    for (const scenario of [flakyCheckout(), failingSubagent(), coldStartReplay()])
      new ScenarioPlayer(fake, scenario).runUntilBlocked();

    const list = fake.snapshot({ kind: "threads" });
    const ids = list && "threads" in list ? Object.keys(list.threads) : [];
    let events = 0;
    for (const id of ids) {
      const threadId = ThreadId.parse(id);
      const batches = new Map<number, EventPayload[]>();
      for (const event of fake.replay({ kind: "thread", threadId }, 0)) {
        const payload =
          event.payload.type === "thread.created"
            ? { ...event.payload, thread: { ...event.payload.thread, workspaceId: workspace } }
            : event.payload;
        batches.set(event.at, [...(batches.get(event.at) ?? []), payload]);
      }
      for (const [at, payloads] of batches) {
        store.appendEvents(threadId, payloads, at);
        events += payloads.length;
      }
    }
    console.log(`[seed] ${ids.length} demo threads (${events} events) into ${home}`);
  }
} finally {
  store.close();
}
