import { delegatedDocs, delegatedDocsIds, facts, type Scenario, type Step } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

type Fact = Extract<Step, { kind: "facts" }>["facts"][number];
beforeEach(() => localStorage.clear());

const spawn = (id: string): Fact[] => [
  facts.tool("root", `spawn-${id}`, {
    kind: "agent.spawn",
    title: `Review ${id}`,
    detail: { kind: "agent.spawn", childAgent: id },
  }),
  {
    type: "agent.seen",
    agent: id,
    parent: "root",
    spawnedBy: `spawn-${id}`,
    origin: "ace",
    fidelity: "full",
    native: { provider: "codex", nativeId: id },
    cwd: "/Users/dev/acme",
    name: `Review ${id}`,
  },
  facts.turn(id, "spawn"),
  facts.message(id, `answer-${id}`, "assistant", "Review in progress", false),
];
function scenario(output: Fact[]): Scenario {
  return {
    thread: {
      id: "inline-subagents",
      workspaceId: "relay",
      provider: "claude",
      title: "Parallel review",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          facts.message("root", "ask", "user", "Review the changes"),
          ...output,
        ],
      },
    ],
  };
}

const group = (feed: HTMLElement, title: string) =>
  within(feed).findByRole("region", { name: title });

test("52 concurrent children share one disclosure, expose every row and retain keyboard navigation", async () => {
  const app = harness();
  app
    .play(scenario(Array.from({ length: 52 }, (_, at) => spawn(`PR-${at + 1}`)).flat()))
    .runUntilBlocked();
  await app.open("/t/inline-subagents");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const card = await group(feed, "52 subagents");
  const disclosure = within(card).getByRole("button", { name: "52 subagents" });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(within(card).getByText("52 working")).toBeTruthy();
  expect(within(card).getByText("+49")).toBeTruthy();
  expect(within(card).queryByRole("list", { name: "Subagents" })).toBeNull();
  disclosure.focus();
  await userEvent.keyboard("{Enter}");
  const rows = within(card).getByRole("list", { name: "Subagents" });
  expect(within(rows).getAllByRole("listitem")).toHaveLength(52);
  const first = within(rows).getByRole("button", { name: "Open Review PR-1, Running" });
  await userEvent.tab();
  expect(document.activeElement).toBe(first);
  await userEvent.click(disclosure);
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(within(card).queryByRole("list", { name: "Subagents" })).toBeNull();
});

test("launch batches separated by the parent's answer retain separate cards at their launch points", async () => {
  const app = harness();
  app
    .play(
      scenario([
        ...spawn("first"),
        ...spawn("second"),
        facts.message("root", "batch-two", "assistant", "Starting the next batch."),
        ...spawn("third"),
      ]),
    )
    .runUntilBlocked();
  await app.open("/t/inline-subagents");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const first = await group(feed, "2 subagents");
  const message = within(feed).getByText("Starting the next batch.");
  const second = await group(feed, "1 subagent");
  expect(first.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(message.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("collapsed status counts follow child completion and human waits through duplicate replay", async () => {
  const app = harness();
  app.play(scenario([...spawn("first"), ...spawn("second")])).runUntilBlocked();
  await app.open("/t/inline-subagents");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const card = await group(feed, "2 subagents");
  app.daemon.duplicateEvents = true;
  await act(async () => {
    app.daemon.disconnectAll();
    app.daemon.apply("inline-subagents", [
      facts.endTurn("first"),
      {
        type: "agent.external",
        agent: "second",
        threadId: ThreadId.parse("child-second"),
        status: { state: "needs_you", interactions: 1 },
      },
    ]);
  });
  await within(card).findByText("1 waiting on you · 1 done");
  expect(within(feed).getAllByRole("button", { name: "2 subagents" })).toHaveLength(1);
  await userEvent.click(within(card).getByRole("button", { name: "2 subagents" }));
  expect(
    within(card)
      .getByRole("link", { name: "Open Review second's thread, Waiting on you" })
      .getAttribute("href"),
  ).toBe("/t/child-second");
  await act(async () =>
    app.daemon.apply("inline-subagents", [
      {
        type: "agent.external",
        agent: "second",
        threadId: ThreadId.parse("child-second"),
        status: { state: "done" },
      },
    ]),
  );
  await within(card).findByText("2 done");
});

test("a finished result is a compact child-thread link with its summary and delivery timestamp", async () => {
  const app = harness();
  for (const script of delegatedDocs()) app.play(script).runUntilBlocked();
  await app.open(`/t/${delegatedDocsIds.parent}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const results = await within(feed).findByRole("list", { name: "Subagent results" });
  const link = within(results).getByRole("link", {
    name: "Open Relay protocol reference's thread, Finished",
  });
  expect(link.textContent).toContain(
    "Wrote docs/protocol/relay.md and documented reconnect behavior.",
  );
  expect(link.querySelector("time")?.getAttribute("datetime")).toBeTruthy();
  expect(within(feed).getAllByRole("button", { name: "1 subagent" })).toHaveLength(1);
  await act(async () =>
    app.daemon.apply(delegatedDocsIds.parent, [
      {
        type: "agent.external",
        agent: "docs",
        threadId: ThreadId.parse(delegatedDocsIds.child),
        status: { state: "needs_you", interactions: 1 },
      },
    ]),
  );
  const waiting = await within(results).findByRole("link", {
    name: "Open Relay protocol reference's thread, Waiting on you",
  });
  expect(waiting.textContent).toContain(
    "Wrote docs/protocol/relay.md and documented reconnect behavior.",
  );
  await userEvent.click(waiting);
  expect(await screen.findByText(/Drafted the frame table/)).toBeTruthy();
});
