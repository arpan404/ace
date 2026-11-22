import {
  ScenarioPlayer,
  facts,
  type FakeDaemon,
  type FakeSpadeApi,
  type Scenario,
} from "@ace/fake-daemon";
import type { ProviderKind } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
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
  how: "working" | "done" | "plan" | "failed",
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
      : how === "failed"
        ? [
            facts.endTurn("root", "failed", {
              kind: "provider",
              code: "session_lost",
              message: "Lost the provider session",
            }),
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

interface Child {
  id: string;
  name: string;
  provider: ProviderKind;
  how: "working" | "done" | "plan" | "failed";
}

const children: readonly Child[] = [
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
function seedResearch(spade: FakeSpadeApi, only: readonly Child[] = children) {
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
      state: each.how === "plan" ? "needs_you" : each.how === "working" ? "working" : each.how,
    });
  }
  const said = "The four research agents are paused pending your approval in the sidebar.";
  spade.store(c, { type: "step_finished", reply: "r1", text: said });
  spade.store(c, { type: "reply_finished", reply: "r1", text: said });
  return research;
}

const play = (daemon: FakeDaemon, only: readonly Child[] = children) => {
  for (const each of only)
    new ScenarioPlayer(
      daemon,
      aceChild(each.id, each.name, each.provider, each.how),
    ).runUntilBlocked();
};

const feed = () => screen.findByRole("feed", { name: "Conversation with Research" });

/** The subagent card whose first line is `header`, and its rows. */
async function card(header: string) {
  const chat = within(await feed());
  const found = await chat.findByRole("region", { name: header });
  return { card: within(found), rows: () => within(found).getAllByRole("listitem") };
}

/** The row of the agent named `name` in `rows`. */
const rowOf = (rows: HTMLElement[], name: string) => {
  const row = rows.find((each) => within(each).queryByText(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
};

test("a bot that delegates to four agents shows one card, one row per agent with its live state", async () => {
  await spadeApp("/spade/research", seedResearch, { daemon: (daemon) => play(daemon) });
  // The bot's own words stay as it wrote them; the card carries the truth.
  expect(
    await within(await feed()).findByText(
      "The four research agents are paused pending your approval in the sidebar.",
    ),
  ).toBeTruthy();
  const { rows } = await card("Research is working with 4 agents");
  await waitFor(() => expect(rows()).toHaveLength(4));
  // Names read as words: the bot's own name, which the card already says, is dropped.
  await waitFor(() =>
    expect(rowOf(rows(), "Pricing").textContent).toContain("Wants you to approve its plan"),
  );
  expect(rowOf(rows(), "Reviews").getAttribute("data-subagent-state")).toBe("working");
  expect(rowOf(rows(), "Features").getAttribute("data-subagent-state")).toBe("working");
  const support = rowOf(rows(), "Support");
  expect(support.getAttribute("data-subagent-state")).toBe("done");
  // A finished agent's second line is what it found.
  await waitFor(() =>
    expect(support.textContent).toContain("Comparing what Research-support found so far."),
  );
});

/** Three of the children, each set to `how`; the first may take the plan child's name. */
function three(how: readonly Child["how"][], first?: Pick<Child, "id" | "name">): Child[] {
  return children.slice(1).map((each, at) => {
    const child: Child = Object.assign({}, each, { how: how[at] ?? "working" });
    return at === 0 && first ? Object.assign(child, first) : child;
  });
}

test("each row opens that agent's thread", async () => {
  const only = three(["working", "working", "working"]);
  const history = createMemoryHistory({ initialEntries: ["/spade/research"] });
  await spadeApp("/spade/research", (spade) => seedResearch(spade, only), {
    history,
    daemon: (daemon) => play(daemon, only),
  });
  // Conversation, not work: there with Show work off, as it is by default.
  const { card: found } = await card("Research is working with 3 agents");
  for (const [name, id] of [
    ["Reviews", "research-reviews"],
    ["Features", "research-features"],
    ["Support", "research-support"],
  ])
    expect(found.getByRole("link", { name: `Open ${name}` }).getAttribute("href")).toBe(`/t/${id}`);
  await userEvent.click(found.getByRole("link", { name: "Open Reviews" }));
  await waitFor(() => expect(history.location.pathname).toBe("/t/research-reviews"));
});

test("a bot the bot made shows its face and state, and Open goes to its chat", async () => {
  const history = createMemoryHistory({ initialEntries: ["/spade/research"] });
  await spadeApp(
    "/spade/research",
    (spade) => {
      const research = seedResearch(spade, []);
      spade.addAgent({
        id: "writer",
        name: "Writer",
        state: "working",
        status: "Drafting the pricing brief for the team",
        parent: { id: "research", name: "Research" },
      });
      spade.store(research.conversation, {
        type: "worker_started",
        worker: "writer",
        kind: "bot",
        name: "Writer",
        call: "d1",
      });
    },
    { history },
  );
  const { card: found, rows } = await card("Research is working with 1 agent");
  await waitFor(() =>
    expect(rowOf(rows(), "Writer").textContent).toContain("Drafting the pricing brief"),
  );
  await userEvent.click(found.getByRole("button", { name: "Open Writer" }));
  await waitFor(() => expect(history.location.pathname).toBe("/spade/writer"));
});

test("a child that needs the person waits in its own row of the card, with its action there", async () => {
  const only = three(["plan", "working", "done"], {
    id: "research-pricing",
    name: "Research-pricing",
  });
  await spadeApp("/spade/research", (spade) => seedResearch(spade, only), {
    daemon: (daemon) => play(daemon, only),
  });
  const { card: found, rows } = await card("Research is working with 3 agents");
  const review = await found.findByRole("button", { name: "Review what Pricing needs" });
  expect(rowOf(rows(), "Pricing").contains(review)).toBe(true);
  // The first line counts who waits on the person.
  expect(within(found.getByRole("banner")).getByText("1 needs you")).toBeTruthy();
  expect(rowOf(rows(), "Pricing").textContent).toContain("Wants you to approve its plan");
  // Its plan waits at the chat's end as ace's own card; nothing else is said of it outside the card.
  const region = await screen.findByRole("region", { name: "Needs you" });
  expect(await within(region).findByText("Plan for Research-pricing")).toBeTruthy();
  expect(within(region).queryByText(/Wants you to approve its plan/)).toBeNull();
});

test("the card never reads finished while a child still works or waits on the person", async () => {
  const only = three(["done", "done", "working"]);
  await spadeApp("/spade/research", (spade) => seedResearch(spade, only), {
    daemon: (daemon) => play(daemon, only),
  });
  const { rows } = await card("Research is working with 3 agents");
  await waitFor(() =>
    expect(rowOf(rows(), "Support").getAttribute("data-subagent-state")).toBe("working"),
  );
  expect(screen.queryByRole("region", { name: /Research worked with/ })).toBeNull();
});

test("once every child has ended the card says the bot worked with them", async () => {
  const only = three(["done", "done", "done"]);
  await spadeApp("/spade/research", (spade) => seedResearch(spade, only), {
    daemon: (daemon) => play(daemon, only),
  });
  const { rows } = await card("Research worked with 3 agents");
  for (const row of rows()) expect(row.getAttribute("data-subagent-state")).toBe("done");
});

test("a failed child says so and why, and the card still says the bot worked with them", async () => {
  const only = three(["done", "failed", "done"]);
  await spadeApp("/spade/research", (spade) => seedResearch(spade, only), {
    daemon: (daemon) => play(daemon, only),
  });
  const { rows } = await card("Research worked with 3 agents");
  await waitFor(() => expect(rowOf(rows(), "Features").textContent).toContain("Failed"));
  expect(rowOf(rows(), "Features").textContent).toContain("Lost the provider session");
});

test("more than five children fold into and N more, which opens to every row", async () => {
  const many: Child[] = Array.from({ length: 8 }, (_, at) => ({
    id: `research-${at}`,
    name: `Research-agent-${at}`,
    provider: "claude",
    how: at === 7 ? "plan" : "done",
  }));
  await spadeApp("/spade/research", (spade) => seedResearch(spade, many), {
    daemon: (daemon) => play(daemon, many),
  });
  const { card: found, rows } = await card("Research is working with 8 agents");
  await waitFor(() => expect(rows()).toHaveLength(5));
  // The one that needs the person is never folded away.
  expect(rowOf(rows(), "Agent 7").textContent).toContain("Wants you to approve its plan");
  await userEvent.click(found.getByRole("button", { name: "and 3 more" }));
  expect(rows()).toHaveLength(8);
  await userEvent.click(found.getByRole("button", { name: "Show fewer" }));
  expect(rows()).toHaveLength(5);
});

test("a child waiting on plan review shows its plan at the chat's end, and Approve reaches the child", async () => {
  const { app } = await spadeApp("/spade/research", seedResearch, {
    daemon: (daemon) => play(daemon),
  });
  const region = await screen.findByRole("region", { name: "Needs you" });
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
  await waitFor(() => expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull());
});

test("Needs you in the bot list opens the chat at the waiting card, and Review goes to its request", async () => {
  await spadeApp("/spade", seedResearch, { daemon: (daemon) => play(daemon) });
  const row = await botRow("Research");
  expect(row.textContent).toContain("Needs you");
  await userEvent.click(row);
  const region = await screen.findByRole("region", { name: "Needs you" });
  await waitFor(() => expect(document.activeElement).toBe(region));

  const { card: found } = await card("Research is working with 4 agents");
  await userEvent.click(await found.findByRole("button", { name: "Review what Pricing needs" }));
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
  const { card: found, rows } = await card("Research is working with 1 agent");
  const open = await found.findByRole("link", { name: "Open Pricing on Build server" });
  expect(rowOf(rows(), "Pricing").textContent).toContain("on Build server");
  expect(open.getAttribute("href")).toBe("/t/research-pricing?machine=build-server");
  const region = await screen.findByRole("region", { name: "Needs you" });
  await userEvent.click(await within(region).findByRole("button", { name: "Approve plan" }));
  await waitFor(() =>
    expect(server.resolution("research-pricing", "plan")).toMatchObject({
      kind: "plan_review",
      decision: "approve",
    }),
  );
});
