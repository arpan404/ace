import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Event, EventPayload, ThreadId } from "@ace/protocol";
import { UsageStore, backfillBatch, type EventHistory } from "@ace/usage";
import { Store } from "./store.ts";

const at = Date.parse("2026-10-02T12:00Z");
const query = { from: "2026-01-01", to: "2026-12-31" };
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A canonical history with skill turns, an automation thread and delegated threads. */
function canonicalHistory(history: Store): Event[] {
  const workspace = history.createWorkspace("/repo", "Repo");
  const events: Event[] = [];
  const append = (thread: string, payload: unknown) =>
    events.push(...history.appendEvents(ThreadId.parse(thread), [EventPayload.parse(payload)], at));
  const thread = (id: string, extra: object = {}) =>
    append(id, {
      type: "thread.created",
      thread: {
        id,
        workspaceId: workspace,
        provider: "codex",
        title: id,
        status: { state: "new" },
        createdAt: at,
        updatedAt: at,
        ...extra,
      },
    });
  const agent = (threadId: string, id: string, parentId: string | null = null) =>
    append(threadId, {
      type: "agent.created",
      agent: {
        id,
        threadId,
        parentId,
        native: { provider: "codex", id },
        origin: parentId ? "provider_subagent" : "root",
        fidelity: "full",
        cwd: "/repo",
        model: "claude-sonnet-4-6",
        status: { state: "idle" },
        createdAt: at,
      },
    });
  let items = 0;
  const message = (threadId: string, agentId: string, skills: string[], extra: object = {}) =>
    append(threadId, {
      type: "item.created",
      item: {
        type: "message",
        id: `item-${++items}`,
        agentId,
        createdAt: at,
        role: "user",
        parts: [
          { type: "text", text: "go" },
          ...skills.map((name) => ({
            type: "mention",
            entryId: `skill:${name}`,
            name,
            kind: "skill",
          })),
        ],
        ...extra,
      },
    });
  const spend = (threadId: string, agentId: string, inputTokens: number) =>
    append(threadId, {
      type: "usage.updated",
      agentId,
      inputTokens,
      outputTokens: 0,
      counterMode: "incremental",
    });

  thread("main");
  agent("main", "root");
  agent("main", "helper", "root");
  message("main", "root", ["review", "tdd", "review"]);
  spend("main", "root", 10);
  // A task notification ace didn't send carries the turn on.
  message("main", "root", [], { synthetic: true });
  spend("main", "helper", 5);
  // The person answering the agent's question carries the turn on too.
  message("main", "root", [], { origin: { kind: "interaction_answer" } });
  spend("main", "root", 1);
  message("main", "root", []);
  spend("main", "root", 7);
  // A fork copy of an older ask is not a new ask.
  message("main", "root", ["review"], { inherited: { threadId: "elsewhere" } });
  spend("main", "root", 2);

  thread("nightly");
  agent("nightly", "nightly-root");
  message("nightly", "nightly-root", ["triage"], {
    origin: { kind: "automation", role: "automation-1" },
  });
  spend("nightly", "nightly-root", 20);

  thread("spawned");
  agent("spawned", "spawned-root");
  spend("spawned", "spawned-root", 30);
  append("spawned", { type: "thread.updated", delegatedBy: "main" });

  thread("started", { startedBy: "main" });
  agent("started", "started-root");
  spend("started", "started-root", 40);
  return events;
}

const grouped = (usage: UsageStore, groupBy: string[]) =>
  Object.fromEntries(
    usage
      .summary({ ...query, groupBy })
      .rows.map((row) => [
        Object.values(row.dimensions).map(String).join("/"),
        row.totals.inputTokens,
      ]),
  );
const attribution = (usage: UsageStore) => ({
  skill: grouped(usage, ["skill"]),
  automation: grouped(usage, ["automation"]),
  role: grouped(usage, ["role"]),
});
async function replay(usage: UsageStore, history: EventHistory) {
  const sink = {
    cursor: async () => usage.cursor(),
    ingest: async (batch: unknown) => usage.ingest(batch),
  };
  while (await backfillBatch(sink, history)) {
    /* Each batch commits its own coverage. */
  }
}

it("the canonical log's asks, automation origins and delegation links attribute usage through replay, restart and rebuild", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-usage-attribution-"));
  homes.push(home);
  const history = new Store(join(home, "events.sqlite"), undefined, { now: () => at });
  let usage = new UsageStore(join(home, "usage.sqlite"));
  try {
    const events = canonicalHistory(history);
    await replay(usage, history);
    const expected = {
      skill: { review: 16, tdd: 16, triage: 20 },
      automation: { null: 95, "automation-1": 20 },
      role: { main: 40, subagent: 5, delegated: 70 },
    };
    expect(attribution(usage)).toEqual(expected);

    usage.close();
    usage = new UsageStore(join(home, "usage.sqlite"));
    expect(attribution(usage)).toEqual(expected);

    usage.close();
    usage = new UsageStore(":memory:");
    await replay(usage, history);
    expect(attribution(usage)).toEqual(expected);

    // Full events decoded in Node attribute exactly what SQLite's compact replay does.
    usage.close();
    usage = new UsageStore(":memory:");
    const headSeq = history.headSeq();
    await replay(usage, {
      readUsagePage: ({ afterSeq }) => ({
        throughSeq: headSeq,
        events: events.filter((event) => event.seq > afterSeq),
      }),
    });
    expect(attribution(usage)).toEqual(expected);
  } finally {
    usage.close();
    history.close();
  }
});
