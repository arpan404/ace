import { windowSource } from "@ace/client-react";
import { facts, FakeDaemon } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { turnTreeOf } from "@ace/ui-core";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";

const id = ThreadId.parse("history-settlement");

async function history(daemon: FakeDaemon) {
  const client = fakeClient(daemon);
  await client.start();
  const lease = client.thread(id);
  await waitFor(() => expect(lease.store.thread?.rootAgentId).toBeTruthy());
  const reply = await client.itemsWindow({ threadId: id, turnOrdinal: 1, before: 0, after: 20 });
  const first = reply.items.find((item) => item.type === "message" && item.role === "assistant");
  if (!first?.runId) throw new Error("Missing first turn in history reply");
  // Construct only after the live snapshot arrives, exactly as a history jump does.
  const source = windowSource(lease.store, { items: reply.items, before: reply.itemsBefore });
  return { source, firstRun: first.runId, release: lease.release };
}

function seed() {
  let now = 1_000;
  const daemon = new FakeDaemon({ clock: () => now, snapshotItems: 2 });
  daemon.createThread({ id, workspaceId: "ace", title: "History", provider: "codex" });
  daemon.apply(id, [
    facts.rootAgent("codex"),
    { type: "turn.started", agent: "root", nativeTurnId: "first", trigger: "user" },
    facts.message("root", "ask", "user", "First question"),
    facts.message("root", "answer", "assistant", "First answer"),
  ]);
  return {
    daemon,
    time: (value: number) => {
      now = value;
    },
  };
}

test("a jumped history turn stays unfinished during its silent continuation and settles when it ends", async () => {
  const { daemon, time } = seed();
  time(10_000);
  daemon.apply(id, [
    { type: "turn.ended", agent: "root", nativeTurnId: "first", outcome: "completed" },
  ]);
  time(40_000);
  daemon.apply(id, [
    {
      type: "turn.started",
      agent: "root",
      nativeTurnId: "continuation",
      trigger: "background_completion",
    },
  ]);
  const { source, firstRun, release } = await history(daemon);
  try {
    const tree = turnTreeOf(source);
    expect(tree.settled(firstRun)).toBe(false);
    expect(tree.clock(firstRun)?.from).toBe(1_000);
    time(50_000);
    daemon.apply(id, [
      { type: "turn.ended", agent: "root", nativeTurnId: "continuation", outcome: "completed" },
    ]);
    await waitFor(() => expect(tree.settled(firstRun)).toBe(true));
    expect(tree.endedAt(firstRun)).toBe(50_000);
  } finally {
    release();
  }
});

test("a history window assigns an unanchored pending root approval to its older server turn", async () => {
  const { daemon, time } = seed();
  time(10_000);
  daemon.apply(id, [
    { type: "turn.ended", agent: "root", nativeTurnId: "first", outcome: "completed" },
  ]);
  time(40_000);
  daemon.apply(id, [
    { type: "turn.started", agent: "root", nativeTurnId: "second", trigger: "user" },
    facts.message("root", "second-ask", "user", "Second question"),
    facts.message("root", "second-answer", "assistant", "Second answer"),
  ]);
  // The older request arrives late, after newer output, with its original server timestamp.
  time(5_000);
  daemon.apply(id, [
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "approval",
      blocking: true,
      request: {
        kind: "approval",
        title: "Approve the first turn?",
        options: [{ id: "deny", kind: "deny", label: "Deny" }],
      },
    },
  ]);
  const { source, firstRun, release } = await history(daemon);
  try {
    const tree = turnTreeOf(source);
    expect(tree.settled(firstRun)).toBe(false);
    time(45_000);
    daemon.apply(id, [
      {
        type: "interaction.closed",
        interaction: "approval",
        state: "resolved",
        resolution: { kind: "approval", optionId: "deny" },
      },
    ]);
    await waitFor(() => expect(tree.settled(firstRun)).toBe(true));
    const latest = source.thread?.live?.rootRunId;
    if (!latest) throw new Error("Missing live second turn");
    expect(tree.settled(latest)).toBe(false);
  } finally {
    release();
  }
});
