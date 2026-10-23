import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentId, ThreadId, type MachineThreadView } from "@ace/protocol";
import { Store } from "@ace/daemon";
import { MachineChildren } from "./children.ts";
import { RequestMirror } from "./mirror.ts";

const homes: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const child = ThreadId.parse("remote-child");
const parent = ThreadId.parse("parent");

/**
 * The ledger of children on other machines, with the other machine played by `views` and the
 * parent by `delivered`. `refusals` makes the next deliveries fail, as a parent not ready does.
 */
function ledger() {
  const home = mkdtempSync(join(tmpdir(), "ace-machine-children-"));
  homes.push(home);
  const store = new Store(join(home, "events.sqlite"));
  stores.push(store);
  let view: MachineThreadView | undefined;
  const delivered: string[] = [];
  const state = { refusals: 0 };
  const children = new MachineChildren({
    store,
    engine: () => undefined,
    now: () => 1_000,
    schedule: () => () => {},
    pollMs: 50,
    status: async () => (view ? [view] : []),
    mirror: new RequestMirror({
      store,
      engine: () => undefined,
      respond: async () => {},
      log: () => {},
    }),
    label: () => "Studio",
    deliver: (_parent, _key, text) => {
      if (state.refusals > 0) {
        state.refusals--;
        throw new Error("Agent control is not ready");
      }
      delivered.push(text);
    },
    waiting: () => false,
    isDescendant: () => false,
    log: () => {},
  });
  children.add({
    id: child,
    requestKey: "parent:fix",
    parentThreadId: parent,
    parentAgentId: AgentId.parse("agent"),
    machine: "studio",
    role: "Fix-flaky-test",
    provider: "claude",
    title: "Fix-flaky-test",
  });
  const report = (next: Partial<MachineThreadView>) => {
    view = {
      threadId: child,
      state: "working",
      title: "Fix-flaky-test",
      elapsedSeconds: 1,
      status: { state: "working", agents: 1 },
      requests: [],
      ...next,
    };
  };
  return { children, delivered, state, report };
}

const done = (result: string, elapsedSeconds: number): Partial<MachineThreadView> => ({
  state: "done",
  status: { state: "done" },
  result,
  elapsedSeconds,
});

it("a message notice the parent couldn't take yet is delivered on a later poll", async () => {
  const h = ledger();
  h.report({
    notice: { text: "Your message wasn't sent.", commandId: "message-a", code: "input_queued" },
  });
  h.state.refusals = 1;
  await h.children.poll();
  expect(h.delivered).toEqual([]);
  await h.children.poll();
  expect(h.delivered).toEqual([expect.stringContaining("Your message wasn't sent.")]);
  await h.children.poll();
  expect(h.delivered).toHaveLength(1);
});

it("two messages refused for the same reason each reach the parent", async () => {
  const h = ledger();
  const text = "Your message wasn't sent (no active turn to steer).";
  h.report({ notice: { text, commandId: "message-a", code: "input_queued" } });
  await h.children.poll();
  h.report({ notice: { text, commandId: "message-b", code: "input_queued" } });
  await h.children.poll();
  expect(h.delivered).toEqual([expect.stringContaining(text), expect.stringContaining(text)]);
});

it("a child messaged again before its result reached the parent still delivers that result", async () => {
  const h = ledger();
  h.report(done("First pass done.", 5));
  h.state.refusals = 1;
  await h.children.poll();
  expect(h.delivered).toEqual([]);
  h.children.reopen(child);
  expect(h.delivered).toEqual([expect.stringContaining("First pass done.")]);
  h.report(done("Docs updated.", 9));
  await h.children.poll();
  expect(h.delivered).toEqual([
    expect.stringContaining("First pass done."),
    expect.stringContaining("Docs updated."),
  ]);
});
