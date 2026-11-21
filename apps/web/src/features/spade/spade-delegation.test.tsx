import {
  ScenarioPlayer,
  facts,
  type FakeDaemon,
  type FakeSpadeApi,
  type Scenario,
} from "@ace/fake-daemon";
import type { ProviderKind } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const cwd = "/Users/dev/relay";

/** An ace agent a bot started: at work, done, or waiting on the person to approve its plan. */
function aceChild(
  id: string,
  title: string,
  provider: ProviderKind,
  how: "working" | "done" | "plan",
): Scenario {
  const words =
    how === "plan"
      ? [
          {
            type: "interaction.opened" as const,
            agent: "root",
            interaction: "plan",
            blocking: true,
            request: {
              kind: "plan_review" as const,
              title: `Plan for ${title}`,
              markdown: "# Plan\n\n1. Read the pricing pages.\n2. Compare the tiers.",
            },
          },
        ]
      : [
          facts.message("root", "say", "assistant", `Comparing what ${title} found so far.`),
          ...(how === "done" ? [facts.endTurn("root")] : []),
        ];
  return {
    thread: { id, workspaceId: "relay", title, provider },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent(provider, cwd),
          facts.turn("root"),
          facts.message("root", "ask", "user", `Research ${title}.`),
          ...words,
        ],
      },
      ...(how === "plan" ? [{ kind: "await" as const, interaction: "plan" }] : []),
    ],
  };
}

const children = [
  {
    id: "research-pricing",
    name: "Research-pricing",
    provider: "codex" as const,
    how: "plan" as const,
  },
  {
    id: "research-reviews",
    name: "Research-reviews",
    provider: "claude" as const,
    how: "working" as const,
  },
  {
    id: "research-features",
    name: "Research-features",
    provider: "claude" as const,
    how: "working" as const,
  },
  {
    id: "research-support",
    name: "Research-support",
    provider: "codex" as const,
    how: "done" as const,
  },
];

/** Research, which started four ace agents with one `delegate`, one of them waiting on a plan. */
function seedResearch(spade: FakeSpadeApi, only = children) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const research = spade.addAgent({
    id: "research",
    name: "Research",
    state: "waiting",
    waiting_for: "worker",
    status: "A worker needs you",
  });
  const c = research.conversation;
  spade.store(c, { type: "user_message", text: "Research the four competitors for me." });
  spade.store(c, { type: "reply_started", reply: "r1" });
  spade.store(c, {
    type: "step_finished",
    reply: "r1",
    text: "I'll start four research agents.",
    calls: [{ id: "d1", name: "delegate", arguments: { tasks: only.map((each) => each.name) } }],
  });
  for (const each of only) {
    spade.store(c, {
      type: "worker_started",
      worker: each.id,
      kind: "ace",
      name: each.name,
      call: "d1",
    });
    spade.work.addAce("research", {
      id: each.id,
      name: each.name,
      state: each.how === "plan" ? "needs_you" : each.how === "done" ? "done" : "working",
    });
  }
  const said = "The four research agents are paused pending your approval in the sidebar.";
  spade.store(c, { type: "step_finished", reply: "r1", text: said });
  spade.store(c, { type: "reply_finished", reply: "r1", text: said });
}

const play = (daemon: FakeDaemon, only = children) => {
  for (const each of only)
    new ScenarioPlayer(
      daemon,
      aceChild(each.id, each.name, each.provider, each.how),
    ).runUntilBlocked();
};

const feed = () => screen.findByRole("feed", { name: "Conversation with Research" });

test("a bot that delegates shows one card for the call, one row per agent with its live state", async () => {
  await spadeApp("/spade/research", seedResearch, { daemon: (daemon) => play(daemon) });
  const chat = within(await feed());
  // The bot's own words stay as it wrote them; the card carries the truth.
  expect(
    await chat.findByText(
      "The four research agents are paused pending your approval in the sidebar.",
    ),
  ).toBeTruthy();
  const head = await chat.findByRole("button", { name: "Started 4 agents" });
  await waitFor(() => expect(head.textContent).toMatch(/1 waiting on you · 2 working · 1 done/));
  await userEvent.click(head);
  const rows = within(chat.getByRole("list", { name: "Subagents" }));
  const pricing = rows.getByRole("link", { name: "Open Research-pricing" });
  expect(pricing.textContent).toContain("Needs you");
  expect(pricing.textContent).toContain("Waiting for you to approve its plan");
  expect(pricing.getAttribute("href")).toBe("/t/research-pricing");
  expect(rows.getByRole("link", { name: "Open Research-reviews" }).textContent).toContain(
    "Running",
  );
  const support = rows.getByRole("link", { name: "Open Research-support" });
  expect(support.textContent).toContain("Done");
  // Its last line: what the agent said last.
  await waitFor(() =>
    expect(support.textContent).toContain("Comparing what Research-support found so far."),
  );
});

test("a child waiting on plan review shows its plan at the chat's end, and Approve reaches the child", async () => {
  const { app } = await spadeApp("/spade/research", seedResearch, {
    daemon: (daemon) => play(daemon),
  });
  const region = await screen.findByRole("region", { name: "Waiting for you" });
  expect(await within(region).findByText("Plan for Research-pricing")).toBeTruthy();
  await userEvent.click(within(region).getByRole("button", { name: "Approve plan" }));
  await waitFor(() =>
    expect(app.daemon.resolution("research-pricing", "plan")).toMatchObject({
      kind: "plan_review",
      decision: "approve",
    }),
  );
  expect(app.daemon.isPending("research-pricing", "plan")).toBe(false);
  // Nothing waits any more: the chat has nothing left to say it needs the person for.
  await waitFor(() => expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull());
});

test("Needs you in the bot list opens the chat at the waiting card, and Review goes to its request", async () => {
  await spadeApp("/spade", seedResearch, { daemon: (daemon) => play(daemon) });
  const row = await botRow("Research");
  expect(row.textContent).toContain("A worker needs you");
  await userEvent.click(row);
  const region = await screen.findByRole("region", { name: "Waiting for you" });
  await waitFor(() => expect(document.activeElement).toBe(region));

  const chat = within(await feed());
  await userEvent.click(await chat.findByRole("button", { name: "Started 4 agents" }));
  await userEvent.click(chat.getByRole("button", { name: "Review what Research-pricing needs" }));
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("data-worker-request")).toBe("research-pricing"),
  );
});

test("a child on another machine shows that machine, opens there and is answered through it", async () => {
  const pricing = children.slice(0, 1);
  const { app } = await spadeApp("/spade/research?on=build-server", () => undefined, {
    machines: [
      {
        hostId: "build-server",
        name: "Build server",
        seed: (spade) => seedResearch(spade, pricing),
      },
    ],
  });
  const server = app.machines.get("build-server");
  if (!server) throw new Error("no build server");
  play(server, pricing);
  const chat = within(await feed());
  const row = await chat.findByRole("link", { name: "Open Research-pricing on Build server" });
  expect(row.textContent).toContain("on Build server");
  expect(row.getAttribute("href")).toBe("/t/research-pricing?machine=build-server");
  const region = await screen.findByRole("region", { name: "Waiting for you" });
  await userEvent.click(await within(region).findByRole("button", { name: "Approve plan" }));
  await waitFor(() =>
    expect(server.resolution("research-pricing", "plan")).toMatchObject({
      kind: "plan_review",
      decision: "approve",
    }),
  );
});
