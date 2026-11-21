import { ScenarioPlayer, facts, type FakeDaemon, type FakeSpadeApi } from "@ace/fake-daemon";
import type { ProviderKind } from "@ace/protocol";

/*
 * `?fakeWorld=spade`, Research: a bot that started four ace agents with one `delegate` to
 * research competitors. One waits on the person to approve its plan, two work, one is done; its
 * chat shows them as one "Started 4 agents" card, the plan at its end, and the bot list says it
 * needs the person.
 */

const children: readonly {
  id: string;
  name: string;
  provider: ProviderKind;
  model: string;
  how: "plan" | "working" | "done";
  said: string;
}[] = [
  {
    id: "research-pricing",
    name: "Research-pricing",
    provider: "codex",
    model: "gpt-6.1-sol",
    how: "plan",
    said: "",
  },
  {
    id: "research-reviews",
    name: "Research-reviews",
    provider: "claude",
    model: "opus-5.5",
    how: "working",
    said: "Reading the G2 and Capterra reviews for the top three.",
  },
  {
    id: "research-features",
    name: "Research-features",
    provider: "claude",
    model: "opus-5.5",
    how: "working",
    said: "Comparing the feature tables on each pricing page.",
  },
  {
    id: "research-support",
    name: "Research-support",
    provider: "codex",
    model: "gpt-6.1-sol",
    how: "done",
    said: "Two of the four answer support within an hour; the notes are in support.md.",
  },
];

export function seedFakeDelegation(
  daemon: FakeDaemon,
  here: FakeSpadeApi,
  minutes: (n: number) => number,
) {
  const research = here.addAgent({
    id: "research",
    name: "Research",
    task: "Research competitors and keep a short brief on each.",
    state: "waiting",
    waiting_for: "worker",
    status: "A worker needs you",
    last_activity: minutes(3),
  });
  const c = research.conversation;
  here.store(c, { type: "user_message", text: "Research our four closest competitors." });
  here.store(c, { type: "reply_started", reply: "r-research" });
  here.store(c, {
    type: "step_finished",
    reply: "r-research",
    text: "I'll start four research agents, one per question.",
    calls: [
      {
        id: "d-research",
        name: "delegate",
        arguments: { tasks: children.map((child) => child.name) },
      },
    ],
  });
  const call = { reply: "r-research", call_id: "d-research", name: "delegate" };
  here.store(c, { type: "tool_started", ...call });
  const workspace =
    daemon.projects.list().workspaces.find((each) => each.name === "relay") ??
    daemon.projects.list().workspaces[0];
  for (const child of children) {
    here.store(c, {
      type: "worker_started",
      worker: child.id,
      kind: "ace",
      name: child.name,
      call: "d-research",
    });
    here.work.addAce("research", {
      id: child.id,
      name: child.name,
      state: child.how === "plan" ? "needs_you" : child.how === "done" ? "done" : "working",
    });
    if (!workspace) continue;
    new ScenarioPlayer(daemon, {
      thread: {
        id: child.id,
        workspaceId: workspace.id,
        title: child.name,
        provider: child.provider,
        execution: { provider: child.provider, model: child.model, options: {} },
      },
      steps: [
        {
          kind: "facts",
          agoMs: 3 * 60_000,
          facts: [
            facts.rootAgent(child.provider, "/Users/dev/relay"),
            facts.turn("root"),
            facts.message("root", "ask", "user", `${child.name}: research our competitors.`),
            ...(child.how === "plan"
              ? [
                  {
                    type: "interaction.opened" as const,
                    agent: "root",
                    interaction: "plan",
                    blocking: true,
                    request: {
                      kind: "plan_review" as const,
                      title: "Compare the four pricing pages",
                      markdown: [
                        "1. Read each competitor's public pricing page.",
                        "2. Put the tiers side by side: price, seats, limits.",
                        "3. Write pricing.md with what changed this quarter.",
                      ].join("\n"),
                    },
                  },
                ]
              : [
                  facts.message("root", "say", "assistant", child.said),
                  ...(child.how === "done" ? [facts.endTurn("root")] : []),
                ]),
          ],
        },
        ...(child.how === "plan" ? [{ kind: "await" as const, interaction: "plan" }] : []),
      ],
    }).runUntilBlocked();
  }
  here.store(c, {
    type: "tool_finished",
    ...call,
    content: JSON.stringify({ ok: true, data: { threadIds: children.map((child) => child.id) } }),
  });
  const said = "The four research agents are paused pending your approval in the sidebar.";
  here.store(c, { type: "step_finished", reply: "r-research", text: said });
  here.store(c, { type: "reply_finished", reply: "r-research", text: said });
}
