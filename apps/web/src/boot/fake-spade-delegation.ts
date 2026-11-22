import { ScenarioPlayer, facts, type FakeDaemon, type FakeSpadeApi } from "@ace/fake-daemon";
import type { ProviderKind } from "@ace/protocol";

/*
 * `?fakeWorld=spade`: bots that started ace agents with one `delegate`, each drawn as one
 * subagent card in its chat.
 *   Research: four agents researching competitors, started 9 minutes ago. One waits on the person
 *   to approve its plan (at the chat's end too), two work, one finished after 6 minutes; the bot
 *   list says it needs the person.
 *   Survey: seven agents that all finished, the card folded past five rows.
 *   Audit: three agents, one of which failed when it lost its provider session.
 */

type How = "plan" | "working" | "done" | "failed";

interface Child {
  id: string;
  name: string;
  provider: ProviderKind;
  model: string;
  how: How;
  /** What it said last: its step while it works, what it found once done, why it failed. */
  said: string;
  /** When it ended, in minutes ago (done or failed). */
  endedMin?: number;
}

interface Scene {
  bot: { id: string; name: string; task: string };
  ask: string;
  start: string;
  said: string;
  /** When the bot started them, in minutes ago. */
  startedMin: number;
  children: readonly Child[];
}

const gpt = { provider: "codex", model: "gpt-6.1-sol" } as const;
const opus = { provider: "claude", model: "opus-5.5" } as const;

const research: Scene = {
  bot: {
    id: "research",
    name: "Research",
    task: "Research competitors and keep a short brief on each.",
  },
  ask: "Research our four closest competitors.",
  start: "I'll start four research agents, one per question.",
  said: "The four research agents are paused pending your approval in the sidebar.",
  startedMin: 9,
  children: [
    { id: "research-pricing", name: "Research-pricing", ...gpt, how: "plan", said: "" },
    {
      id: "research-reviews",
      name: "Research-reviews",
      ...opus,
      how: "working",
      said: "Reading the G2 and Capterra reviews for the top three.",
    },
    {
      id: "research-features",
      name: "Research-features",
      ...opus,
      how: "working",
      said: "Comparing the feature tables on each pricing page.",
    },
    {
      id: "research-support",
      name: "Research-support",
      ...gpt,
      how: "done",
      said: "Two of the four answer support within an hour; the notes are in support.md.",
      endedMin: 3,
    },
  ],
};

const countries = ["Germany", "France", "Spain", "Italy", "Japan", "Brazil", "Canada"];

const survey: Scene = {
  bot: { id: "survey", name: "Survey", task: "Size the market in each country we sell to." },
  ask: "Size our seven markets.",
  start: "I'll start one agent per market.",
  said: "All seven markets are sized; the notes are in each agent's file.",
  startedMin: 26,
  children: countries.map((country, at): Child => ({
    id: `survey-${country.toLowerCase()}`,
    name: `Survey-${country.toLowerCase()}`,
    provider: at % 2 ? gpt.provider : opus.provider,
    model: at % 2 ? gpt.model : opus.model,
    how: "done",
    said: `${country} is sized; the notes are in ${country.toLowerCase()}.md.`,
    endedMin: 4 + at * 2,
  })),
};

const audit: Scene = {
  bot: {
    id: "audit",
    name: "Audit",
    task: "Check our dependencies for licence and security issues.",
  },
  ask: "Audit the three services' dependencies.",
  start: "I'll start one agent per service.",
  said: "Two services are clean; the billing audit lost its provider session.",
  startedMin: 18,
  children: [
    {
      id: "audit-web",
      name: "Audit-web",
      ...opus,
      how: "done",
      said: "No licence or security issues in web's 412 packages.",
      endedMin: 7,
    },
    {
      id: "audit-billing",
      name: "Audit-billing",
      ...gpt,
      how: "failed",
      said: "Lost the provider session",
      endedMin: 11,
    },
    {
      id: "audit-relay",
      name: "Audit-relay",
      ...opus,
      how: "done",
      said: "relay pins an old ws; the upgrade is in relay.md.",
      endedMin: 5,
    },
  ],
};

/** Where an agent's thread starts and what it says, by how it stands. */
function childFacts(child: Child) {
  const head = [
    facts.rootAgent(child.provider, "/Users/dev/relay"),
    facts.turn("root"),
    facts.message("root", "ask", "user", `${child.name}: do your part.`),
  ];
  switch (child.how) {
    case "plan":
      return [
        ...head,
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
      ];
    case "working":
      return [...head, facts.message("root", "say", "assistant", child.said)];
    case "done":
      return [
        ...head,
        facts.message("root", "say", "assistant", child.said),
        facts.endTurn("root"),
      ];
    case "failed":
      return [
        ...head,
        facts.endTurn("root", "failed", {
          kind: "provider",
          code: "session_lost",
          message: child.said,
        }),
      ];
  }
}

const treeState: Record<How, string> = {
  plan: "needs_you",
  working: "working",
  done: "done",
  failed: "failed",
};

function seedScene(
  daemon: FakeDaemon,
  here: FakeSpadeApi,
  minutes: (n: number) => number,
  scene: Scene,
  waiting: boolean,
) {
  const bot = here.addAgent({
    ...scene.bot,
    ...(waiting
      ? { state: "waiting", waiting_for: "worker", status: "A worker needs you" }
      : { state: "idle" }),
    last_activity: minutes(waiting ? 3 : scene.startedMin - 1),
  });
  const c = bot.conversation;
  const started = minutes(scene.startedMin);
  const reply = `r-${scene.bot.id}`;
  const callId = `d-${scene.bot.id}`;
  here.store(c, { type: "user_message", text: scene.ask }, started);
  here.store(c, { type: "reply_started", reply }, started);
  here.store(
    c,
    {
      type: "step_finished",
      reply,
      text: scene.start,
      calls: [
        {
          id: callId,
          name: "delegate",
          arguments: { tasks: scene.children.map((child) => child.name) },
        },
      ],
    },
    started,
  );
  const call = { reply, call_id: callId, name: "delegate" };
  here.store(c, { type: "tool_started", ...call }, started);
  const workspace =
    daemon.projects.list().workspaces.find((each) => each.name === "relay") ??
    daemon.projects.list().workspaces[0];
  for (const child of scene.children) {
    here.store(
      c,
      { type: "worker_started", worker: child.id, kind: "ace", name: child.name, call: callId },
      started,
    );
    here.work.addAce(scene.bot.id, { id: child.id, name: child.name, state: treeState[child.how] });
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
          // An agent that ended last changed then; one still at it, when it started.
          agoMs: (child.endedMin ?? scene.startedMin) * 60_000,
          facts: childFacts(child),
        },
        ...(child.how === "plan" ? [{ kind: "await" as const, interaction: "plan" }] : []),
      ],
    }).runUntilBlocked();
  }
  here.store(c, {
    type: "tool_finished",
    ...call,
    content: JSON.stringify({
      ok: true,
      data: { threadIds: scene.children.map((child) => child.id) },
    }),
  });
  here.store(c, { type: "step_finished", reply, text: scene.said });
  here.store(c, { type: "reply_finished", reply, text: scene.said });
}

export function seedFakeDelegation(
  daemon: FakeDaemon,
  here: FakeSpadeApi,
  minutes: (n: number) => number,
) {
  seedScene(daemon, here, minutes, research, true);
}

export function seedFakeSurvey(
  daemon: FakeDaemon,
  here: FakeSpadeApi,
  minutes: (n: number) => number,
) {
  seedScene(daemon, here, minutes, survey, false);
  seedScene(daemon, here, minutes, audit, false);
}
