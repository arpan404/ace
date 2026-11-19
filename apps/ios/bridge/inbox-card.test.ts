import "./test-host.ts";
import { expect, test } from "vitest";
import { ServerMessage, ThreadListEntry } from "@ace/protocol";
import type { AccountView } from "@ace/ui-core";
import { rowCard } from "./inbox-card.ts";
import { noAgentUse, readAgentUse } from "./inbox-agent-use.ts";

const entry = (extra: Record<string, unknown> = {}) =>
  ThreadListEntry.parse({
    id: "t1",
    workspaceId: "ace",
    title: "Fix the flaky queue test",
    provider: "codex",
    createdAt: 0,
    updatedAt: 10,
    status: { state: "done" },
    execution: { provider: "codex", instanceId: "work" },
    details: {
      workspace: { id: "ace", name: "ace-next", path: "/code/ace-next" },
      branch: "work/rewrite-the-relay-outbox-streams",
      diff: { files: 3, additions: 120, deletions: 8 },
      linkedPrs: [
        {
          number: 1188,
          state: "open",
          title: "Rewrite the relay outbox",
          url: "https://github.com/arpan404/ace/pull/1188",
          repo: { forge: "github", host: "github.com", owner: "arpan404", name: "ace" },
          updatedAt: 1,
        },
      ],
    },
    ...extra,
  });

const work = { id: "work", label: "Work" } as unknown as AccountView;
const context = { baseline: 0, now: 100, settled: false, accounts: [work], use: noAgentUse };

test("a row carries the desktop card's branch, lines changed, pull requests and account", () => {
  const card = rowCard(entry(), context);
  // Cut in the middle so both ends stay, as the desktop's last line shows it.
  expect(card.branchLabel).toMatch(/^work\/rewrite.*….*-streams$/);
  expect(Array.from(card.branchLabel ?? "").length).toBeLessThanOrEqual(24);
  expect(card.work).toEqual({ added: 120, removed: 8 });
  expect(card.prs).toEqual([
    { number: 1188, state: "open", repo: "arpan404/ace", title: "Rewrite the relay outbox" },
  ]);
  expect(card.accountLabel).toBe("Work");
});

test("a thread that changed no lines shows no counts, and an unknown account no name", () => {
  const card = rowCard(
    entry({
      execution: { provider: "codex", instanceId: "other" },
      details: { diff: { files: 0, additions: 0, deletions: 0 } },
    }),
    context,
  );
  expect(card.work).toBeNull();
  expect(card.branchLabel).toBeNull();
  expect(card.accountLabel).toBeNull();
});

test("the preview says what a thread waits on in the hover card's words", () => {
  const card = rowCard(entry({ status: { state: "needs_you", interactions: 1 } }), context);
  expect(card.hover?.sentence).toBeTruthy();
  expect(card.hover?.ink).toBe("warning");
  expect(rowCard(entry(), { ...context, settled: true }).hover).toBeNull();
});

test("browsing and computer use mark only the threads an agent drives, and say which changed", () => {
  const browsing = readAgentUse(
    noAgentUse,
    ServerMessage.parse({ type: "browser.browsing", threads: ["t1"] }),
  );
  expect(browsing?.changed).toEqual(["t1"]);
  const using = readAgentUse(
    browsing!.next,
    ServerMessage.parse({
      type: "computer.using",
      threads: [{ threadId: "t2", apps: ["Calculator", "Notes", "Xcode"] }],
    }),
  );
  expect(using?.changed).toEqual(["t2"]);
  const use = using!.next;
  expect(rowCard(entry(), { ...context, use })).toMatchObject({
    browsing: "An agent is browsing",
    computerUse: null,
  });
  expect(rowCard(entry({ id: "t2" }), { ...context, use })).toMatchObject({
    browsing: null,
    computerUse: "An agent is using Calculator, Notes and 1 more",
  });
  // The browser stops: only that thread changes.
  expect(
    readAgentUse(use, ServerMessage.parse({ type: "browser.browsing", threads: [] }))?.changed,
  ).toEqual(["t1"]);
});
