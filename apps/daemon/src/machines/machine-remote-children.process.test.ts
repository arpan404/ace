import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { z } from "zod";
import { MonitorSnapshot, ThreadId, type AgentControlOperation } from "@ace/protocol";
import { loadHostId } from "../local-files.ts";
import { pairedMachines } from "./machine-test-support.ts";

type Pair = Awaited<ReturnType<typeof pairedMachines>>;
const Delegated = z.object({ threadId: ThreadId });
const delegation = {
  op: "delegate_task",
  requestId: "review-on-studio",
  task: "Summarize the open pull requests",
  role: "Review-open-pull-requests",
  provider: "claude",
  machine: "studio",
  project: "project",
} satisfies AgentControlOperation;

/** The host's thread list as its clients read it: entries and per-project totals. */
const hostList = (pair: Pair) => pair.target.daemon.store.sidebarPage({ limit: 50 });
const listed = (pair: Pair, id: string) => hostList(pair).threads.find((entry) => entry.id === id);

it("a thread delegated from a paired machine names its parent there and is not counted as the host's own", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.source.call({ op: "machines" });
  const countsBefore = hostList(pair).window.counts;
  const { threadId } = Delegated.parse((await pair.source.call(delegation)).data);

  // The host's clients can tell it apart from its own threads: it names the parent and machine.
  expect(listed(pair, threadId)?.delegatedFrom).toEqual({
    hostId: loadHostId(join(pair.source.h.home, "daemon")),
    hostName: expect.any(String),
    threadId: pair.source.caller.threadId,
  });
  // It is still a task there, so a link or search opens it, but no project counts it.
  expect(listed(pair, threadId)?.hasSentMessage).toBe(true);
  expect(hostList(pair).window.counts).toEqual(countsBefore);

  // The parent's machine still sees the child's true state.
  const status = MonitorSnapshot.parse((await pair.source.call({ op: "agents.status" })).data);
  expect(status.children).toEqual([expect.objectContaining({ id: threadId, machine: "Studio" })]);
}, 60_000);

it("a thread delegated before the host recorded its parent's machine is marked when the host upgrades", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.source.call({ op: "machines" });
  const { threadId } = Delegated.parse((await pair.source.call(delegation)).data);

  // The stored thread goes back to how an older host kept it: listed, with no parent machine.
  await pair.restartTarget((dataDir) => {
    const db = new DatabaseSync(join(dataDir, "events.sqlite"));
    try {
      db.prepare(
        "UPDATE threads SET transitions = json_remove(transitions, '$.delegatedFrom') WHERE id = ?",
      ).run(threadId);
    } finally {
      db.close();
    }
  });

  expect(listed(pair, threadId)?.delegatedFrom).toEqual({
    hostId: loadHostId(join(pair.source.h.home, "daemon")),
    hostName: expect.any(String),
    threadId: pair.source.caller.threadId,
  });
}, 60_000);
