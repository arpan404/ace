import type { FakeDeckCard, FakeDeckRun, FakeDeckScenario, FakeLane } from "./types.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/**
 * The decks in the approved design: one waiting to merge a card, one with an escalation and a
 * worker's question, two merged. Times are relative to `now`, so ages read the same whenever
 * the fake starts. `extra` adds staged decks for the states the design's world doesn't hold.
 */
export function deckRuns(now: number, extra: readonly FakeDeckScenario[] = []): FakeDeckRun[] {
  return [
    relayStreams(now),
    mobileColdStart(now),
    themeSystem(now),
    codexBump(now),
    ...extra.map((scenario) => stagedDeck(scenario, now)),
  ];
}

const stages = ["Foundation", "Build", "Integrate", "Ship"];

function card(
  id: string,
  title: string,
  dependencies: string[],
  state: FakeDeckCard["state"],
  extra: Partial<Pick<FakeDeckCard, "round" | "lane" | "note" | "question" | "brief">> = {},
): FakeDeckCard {
  return {
    id,
    kind: id === "merge" ? "merge" : "work",
    title,
    dependencies,
    state,
    round: extra.round ?? 0,
    lane: extra.lane ?? null,
    note: extra.note ?? "",
    ...(extra.question ? { question: extra.question } : {}),
    ...(extra.brief ? { brief: extra.brief } : {}),
  };
}

const brief = (objective: string, ...acceptance: string[]) => ({ objective, acceptance });

const sequenceNumbers: FakeLane = {
  worker: {
    account: "claude-personal",
    provider: "claude",
    detail: "Sonnet 4.6, worktree lanes/sequence-numbers",
  },
  reviewer: {
    account: "codex-personal",
    provider: "codex",
    detail: "Adversarial: replays out-of-order and duplicated frames",
  },
  threadId: null,
  rounds: [
    {
      label: "Round 1",
      verdict: "Approved",
      detail: "merged as #211",
      findings: [],
    },
  ],
};

const clientAck: FakeLane = {
  worker: {
    account: "codex-personal",
    provider: "codex",
    detail: "GPT-5.3 Codex, worktree lanes/client-ack",
  },
  reviewer: {
    account: "claude-work",
    provider: "claude",
    detail: "Adversarial: tries to break the ack ordering",
  },
  threadId: "thread-dedupe",
  rounds: [
    {
      label: "Round 1",
      verdict: "Request changes",
      detail: "2 findings",
      findings: [
        {
          severity: "high",
          text: "Buffer is cleared before the resume.ack arrives, so a second restart loses messages.",
        },
        { severity: "low", text: "No test for an ack that arrives after the socket closes." },
      ],
    },
    { label: "Round 2", verdict: "Fixing", detail: "worker is on finding 1, 4m in", findings: [] },
  ],
};

const replayCursor: FakeLane = {
  worker: {
    account: "claude-personal",
    provider: "claude",
    detail: "Opus 4.6, worktree lanes/replay-cursor",
  },
  reviewer: {
    account: "codex-personal",
    provider: "codex",
    detail: "Adversarial: replays with gaps and out-of-order seqs",
  },
  threadId: null,
  rounds: [
    {
      label: "Round 1",
      verdict: "Approved",
      detail: "Replayed 14 scenarios with gaps and out-of-order sequences; no duplicates.",
      findings: [],
    },
  ],
};

const coldStartReplay: FakeLane = {
  worker: {
    account: "gemini-google",
    provider: "acp",
    detail: "Worktree lanes/mobile-cold-start on build-box",
  },
  reviewer: { account: "claude-work", provider: "claude", detail: "Adversarial" },
  threadId: null,
  rounds: [
    {
      label: "Round 1",
      verdict: "Request changes",
      detail: "cannot run the iOS simulator on build-box",
      findings: [],
    },
    { label: "Round 2", verdict: "Working", detail: "moved to this Mac", findings: [] },
  ],
};

const soakTest: FakeLane = {
  worker: {
    account: "opencode",
    provider: "opencode",
    detail: "Soak harness: 500 reconnects per run",
  },
  reviewer: {
    account: "codex-team",
    provider: "codex",
    detail: "Checks the harness itself for false passes",
  },
  threadId: null,
  rounds: [
    {
      label: "Round 1",
      verdict: "Working",
      detail: "212 of 500 reconnects, 0 duplicates",
      findings: [],
    },
  ],
};

function relayStreams(now: number): FakeDeckRun {
  const createdAt = now - 3 * hour;
  return {
    id: "relay-streams",
    title: "Resumable relay streams",
    goal: "Make every relay stream resumable after a daemon restart, a phone reconnect or a network blip, without duplicate events.",
    workspaceId: "ace",
    branch: "deck/resumable-streams",
    phase: "dealing",
    planApproved: true,
    gate: {
      id: "relay-streams-merge-replay-cursor",
      kind: "merge",
      body: "Merge lanes/replay-cursor at 9f2c41ab7d3e5f60812c4b9a0d7e6f5a4b3c2d1e",
      cardId: "replay-cursor",
      revision: 1,
    },
    stages,
    cards: [
      card("sequence-numbers", "Sequence numbers on every event", [], "merged", {
        round: 1,
        lane: sequenceNumbers,
        note: "Merged into deck/resumable-streams as #211. Reviewer approved on round 1.",
        brief: brief(
          "Stamp every relay event with a per-stream, gap-free sequence number.",
          "Sequence numbers increase by one per event and survive a daemon restart.",
        ),
      }),
      card("replay-cursor", "Server-side replay cursor", ["sequence-numbers"], "approved", {
        round: 1,
        lane: replayCursor,
        brief: brief(
          "Keep a per-client cursor on the daemon and replay only the events after it on resume.",
          "A resumed stream starts at the event after the client's last acknowledged sequence.",
          "Replaying across a daemon restart sends no duplicates.",
        ),
      }),
      card("client-ack", "Client ack and buffer flush", ["sequence-numbers"], "fixing", {
        round: 2,
        lane: clientAck,
        brief: brief(
          "Acknowledge each applied event and flush the client buffer only after resume.ack.",
          "A second restart before resume.ack loses no messages.",
          "An ack arriving after the socket closes is ignored.",
        ),
      }),
      card("cold-start-replay", "Mobile cold-start replay", ["sequence-numbers"], "working", {
        round: 2,
        lane: coldStartReplay,
        brief: brief(
          "Replay missed events when the phone app cold-starts, before the first frame.",
          "A cold start after a 10 minute gap shows every missed event once.",
        ),
      }),
      card(
        "soak-test",
        "Reconnect soak test",
        ["replay-cursor", "client-ack", "cold-start-replay"],
        "working",
        {
          round: 1,
          lane: soakTest,
          brief: brief(
            "Reconnect 500 times under load and count duplicated or missing events.",
            "500 reconnects show no duplicates and no gaps.",
          ),
        },
      ),
      card("migration-note", "Migration note and docs", ["replay-cursor"], "planned", {
        note: "Starts when its dependencies merge.",
        brief: brief(
          "Document the resume protocol and what older clients see.",
          "The protocol docs describe resume, ack and replay.",
        ),
      }),
      card("merge", "Merge to main", ["soak-test", "migration-note"], "merge", {
        note: "Merges automatically once every card is approved by its reviewer and you approve the merge.",
      }),
    ],
    log: [
      { at: createdAt, text: "Deck started from the goal." },
      { at: createdAt + 4 * minute, text: "Planner proposed 6 cards in 4 stages." },
      { at: createdAt + 9 * minute, text: "You approved plan revision 1." },
      { at: createdAt + 41 * minute, text: "Sequence numbers on every event merged as #211." },
      {
        at: createdAt + 72 * minute,
        text: "Reviewer requested changes on Client ack and buffer flush: 2 findings.",
      },
      {
        at: createdAt + 118 * minute,
        text: "Mobile cold-start replay moved to this Mac to run the iOS simulator.",
      },
      { at: createdAt + 158 * minute, text: "Server-side replay cursor passed review." },
    ],
    pullRequest: null,
    spent: 11,
    budget: 50,
    createdAt,
    updatedAt: now - 22 * minute,
  };
}

function coldStartLane(
  account: string,
  provider: FakeLane["worker"]["provider"],
  detail: string,
): FakeLane {
  return {
    worker: { account, provider, detail },
    reviewer: {
      account: "claude-work",
      provider: "claude",
      detail: "Adversarial: measures cold start on a throttled device profile",
    },
    threadId: null,
    rounds: [{ label: "Round 1", verdict: "Working", detail: "", findings: [] }],
  };
}

function mobileColdStart(now: number): FakeDeckRun {
  const createdAt = now - 48 * minute;
  return {
    id: "mobile-cold-start",
    title: "Mobile cold start under 1s",
    goal: "Bring the phone app's cold start under one second on a mid-range Android device.",
    workspaceId: "ace-mobile",
    branch: "deck/cold-start",
    phase: "dealing",
    planApproved: true,
    gate: {
      id: "mobile-cold-start-escalation-1",
      kind: "escalation",
      body: "Deferring the first sync leaves the inbox empty for about 3s after launch, and the reviewer rejected that both times.",
      cardId: "defer-sync",
      revision: 1,
    },
    stages: ["Measure", "Build", "Ship"],
    cards: [
      card("trace", "Startup trace baseline", [], "merged", {
        round: 1,
        lane: {
          ...coldStartLane("codex-personal", "codex", "GPT-5.3 Codex, worktree lanes/trace"),
          rounds: [
            { label: "Round 1", verdict: "Approved", detail: "merged as #88", findings: [] },
          ],
        },
        note: "Merged as #88. Baseline is 1.84s on the Pixel 6a profile.",
        brief: brief(
          "Record a startup trace on a mid-range Android profile as the baseline.",
          "The trace names the five slowest startup phases.",
        ),
      }),
      card("lazy-fonts", "Lazy-load fonts and icons", ["trace"], "working", {
        round: 1,
        lane: coldStartLane("claude-personal", "claude", "Sonnet 4.6, worktree lanes/lazy-fonts"),
        brief: brief(
          "Load fonts and icon sets after the first frame instead of before it.",
          "The first frame draws with system fonts and no layout shift.",
          "Cold start drops by at least 200ms on the Pixel 6a profile.",
        ),
      }),
      card("hermes-bytecode", "Precompile Hermes bytecode", ["trace"], "working", {
        round: 1,
        lane: coldStartLane("codex-personal", "codex", "GPT-5.3 Codex, worktree lanes/hermes"),
        brief: brief(
          "Ship Hermes bytecode so the JS bundle isn't parsed on launch.",
          "Release builds start from precompiled bytecode.",
        ),
        question: {
          text: "Ship the precompiled bytecode in the APK, or build it on the first launch?",
          options: [
            { id: "apk", label: "Ship it in the APK" },
            { id: "first-launch", label: "Build it on first launch" },
          ],
        },
      }),
      card("defer-sync", "Defer the first relay sync", ["trace"], "escalated", {
        round: 2,
        lane: coldStartLane("opencode", "opencode", "Worktree lanes/defer-sync"),
        brief: brief(
          "Start the first relay sync after the inbox renders from cache.",
          "The inbox shows cached threads within 1s of launch.",
          "New events arrive within 5s of launch.",
        ),
      }),
      card("merge", "Merge to main", ["lazy-fonts", "hermes-bytecode", "defer-sync"], "merge", {
        note: "Merges once every card passes review and you approve the merge.",
      }),
    ],
    log: [
      { at: createdAt, text: "Deck started from the goal." },
      { at: createdAt + 3 * minute, text: "You approved plan revision 1." },
      { at: createdAt + 20 * minute, text: "Startup trace baseline merged as #88." },
      { at: createdAt + 21 * minute, text: "Dealt 3 cards to lanes." },
    ],
    pullRequest: null,
    spent: 9,
    budget: 50,
    createdAt,
    updatedAt: now - 2 * minute,
  };
}

function merged(
  now: number,
  options: {
    id: string;
    title: string;
    goal: string;
    workspaceId: string;
    age: number;
    pullRequest: number;
    cards: string[];
  },
): FakeDeckRun {
  const createdAt = now - options.age - 5 * hour;
  return {
    id: options.id,
    title: options.title,
    goal: options.goal,
    workspaceId: options.workspaceId,
    branch: `deck/${options.id}`,
    phase: "merged",
    planApproved: true,
    gate: null,
    stages: ["Build", "Ship"],
    cards: [
      ...options.cards.map((title, index) =>
        card(`card-${index + 1}`, title, [], "merged", { note: "Merged. Reviewer approved." }),
      ),
      card(
        "merge",
        "Merge to main",
        options.cards.map((_, index) => `card-${index + 1}`),
        "merged",
        { note: `Merged to main as #${options.pullRequest}.` },
      ),
    ],
    log: [
      { at: createdAt, text: "Deck started from the goal." },
      { at: now - options.age, text: `Merged to main as #${options.pullRequest}.` },
    ],
    pullRequest: options.pullRequest,
    spent: options.cards.length * 2 + 1,
    budget: 50,
    createdAt,
    updatedAt: now - options.age,
  };
}

function themeSystem(now: number): FakeDeckRun {
  return merged(now, {
    id: "theme-system-v2",
    title: "Theme system v2",
    goal: "Generate every theme from a small seed and ship seven presets with a token editor.",
    workspaceId: "ace",
    age: 2 * day,
    pullRequest: 196,
    cards: [
      "Theme seeds and expansion",
      "Seven presets",
      "Accent picker",
      "Theme editor",
      "Contrast checks",
    ],
  });
}

function codexBump(now: number): FakeDeckRun {
  return merged(now, {
    id: "codex-app-server-048",
    title: "Codex app-server 0.48",
    goal: "Move to Codex app-server 0.48 and adopt its resumable turn events.",
    workspaceId: "ace",
    age: 41 * minute,
    pullRequest: 212,
    cards: ["Bump the protocol bindings", "Adopt resumable turn events"],
  });
}

/**
 * Decks in states the design's world doesn't hold, added by `deckRuns(now, extra)` or
 * `FakeConductor.stage()`: a first plan waiting for approval, a deck that used its budget, and a
 * card whose lane stopped responding.
 */
export function stagedDeck(scenario: FakeDeckScenario, now: number): FakeDeckRun {
  const createdAt = now - 90 * minute;
  const base = {
    workspaceId: "ace",
    pullRequest: null,
    createdAt,
    updatedAt: now - 6 * minute,
    log: [{ at: createdAt, text: "Deck started from the goal." }],
  };
  const lane = (worker: string, provider: FakeLane["worker"]["provider"]): FakeLane => ({
    worker: { account: worker, provider, detail: "Worktree lane" },
    reviewer: { account: "claude-work", provider: "claude", detail: "Adversarial" },
    threadId: null,
    rounds: [{ label: "Round 1", verdict: "Working", detail: "", findings: [] }],
  });
  switch (scenario) {
    case "planning":
      return {
        ...base,
        id: "search-ranking",
        title: "Rank search results by recency",
        goal: "Rank search results by recency and thread activity, with a stable order for ties.",
        branch: "deck/search-ranking",
        phase: "planning",
        planApproved: false,
        gate: {
          id: "search-ranking-rev-1",
          kind: "plan",
          body: "Revision 1: 3 cards in 2 stages. Nothing starts until you approve.",
          cardId: null,
          revision: 1,
        },
        stages: ["Build", "Ship"],
        cards: [
          card("score", "Recency score", [], "planned", {
            note: "Starts once the plan is approved.",
            brief: brief(
              "Score each hit by its thread's last activity, decaying over a week.",
              "A thread active today ranks above an identical one from last week.",
            ),
          }),
          card("ties", "Stable tie order", [], "planned", {
            note: "Starts once the plan is approved.",
            brief: brief(
              "Break score ties by thread id so results never reorder between searches.",
              "Repeating a search returns the same order.",
            ),
          }),
          card("ranking-docs", "Search docs", ["score", "ties"], "planned", {
            note: "Starts after Recency score and Stable tie order.",
            brief: brief("Explain the ranking in the search docs.", "The docs name each signal."),
          }),
          card("merge", "Merge to main", ["ranking-docs"], "merge"),
        ],
        spent: 1,
        budget: 50,
      };
    case "budget":
      return {
        ...base,
        id: "settings-sync",
        title: "Sync settings across devices",
        goal: "Sync settings across paired devices, with conflicts resolved per setting.",
        branch: "deck/settings-sync",
        phase: "dealing",
        planApproved: true,
        gate: {
          id: "settings-sync-budget",
          kind: "budget",
          body: "Reserved cost 51 exceeds budget 50",
          cardId: null,
          revision: 1,
        },
        stages: ["Build", "Ship"],
        cards: [
          card("sync-store", "Synced settings store", [], "merged", {
            note: "Merged into deck/settings-sync.",
            brief: brief("Keep synced settings in one store.", "Every device reads one value."),
          }),
          card("conflicts", "Per-setting conflict rules", ["sync-store"], "fixing", {
            round: 4,
            lane: lane("codex-personal", "codex"),
            brief: brief(
              "Resolve conflicting edits per setting, newest wins unless the setting says otherwise.",
              "Two devices editing different settings both keep their edits.",
            ),
          }),
          card("merge", "Merge to main", ["conflicts"], "merge"),
        ],
        spent: 50,
        budget: 50,
      };
    case "unresponsive":
      return {
        ...base,
        id: "export-threads",
        title: "Export threads as Markdown",
        goal: "Export any thread as a Markdown file with its attachments.",
        branch: "deck/export-threads",
        phase: "dealing",
        planApproved: true,
        gate: {
          id: "export-threads-stalled",
          kind: "escalation",
          body: "Lane export-writer.worker is unresponsive",
          cardId: "export-writer",
          revision: 1,
        },
        stages: ["Build", "Ship"],
        cards: [
          card("export-writer", "Markdown writer", [], "escalated", {
            round: 1,
            lane: lane("claude-personal", "claude"),
            brief: brief(
              "Write a thread's messages, steps and attachments as Markdown.",
              "Code blocks and images survive a round trip through the export.",
            ),
          }),
          card("export-menu", "Export menu item", [], "working", {
            round: 1,
            lane: lane("codex-personal", "codex"),
            brief: brief("Add Export to the thread menu.", "Export saves a .md file."),
          }),
          card("merge", "Merge to main", ["export-writer", "export-menu"], "merge"),
        ],
        spent: 5,
        budget: 50,
      };
  }
}
