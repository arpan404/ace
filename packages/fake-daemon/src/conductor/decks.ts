import type { FakeDeckCard, FakeDeckRun, FakeLane } from "./types.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/**
 * The decks in the approved design: one gated on a plan revision, one dealing, two merged.
 * Times are relative to `now`, so ages read the same whenever the fake starts.
 */
export function deckRuns(now: number): FakeDeckRun[] {
  return [relayStreams(now), mobileColdStart(now), themeSystem(now), codexBump(now)];
}

const stages = ["Foundation", "Build", "Integrate", "Ship"];

function card(
  id: string,
  title: string,
  dependencies: string[],
  state: FakeDeckCard["state"],
  extra: Partial<Pick<FakeDeckCard, "round" | "lane" | "note">> = {},
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
  };
}

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
      verdict: "In review",
      detail: "reviewer has run 14 replay scenarios so far",
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
    { label: "Round 2", verdict: "Request changes", detail: "same blocker", findings: [] },
    { label: "Escalated", verdict: "Waiting for you", detail: "See the gate above.", findings: [] },
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
      id: "relay-streams-rev-2",
      kind: "plan",
      title: "Deck plan needs your approval",
      body: "Revision 2: Mobile cold-start replay failed review twice because its lane cannot run the iOS simulator on build-box. The deck wants to move it to this Mac and split the simulator test into a seventh card.",
      revision: 2,
      changes: [
        {
          kind: "moved",
          cardId: "cold-start-replay",
          title: "Mobile cold-start replay",
          detail: "Runs on this Mac instead of build-box, so the lane can boot the iOS simulator.",
        },
        {
          kind: "added",
          cardId: "simulator-replay-test",
          title: "Simulator replay test",
          detail: "Split out of Mobile cold-start replay. Replays a cold start in the simulator.",
          dependencies: ["cold-start-replay"],
        },
      ],
    },
    stages,
    cards: [
      card("sequence-numbers", "Sequence numbers on every event", [], "merged", {
        round: 1,
        lane: sequenceNumbers,
        note: "Merged into deck/resumable-streams as #211. Reviewer approved on round 1.",
      }),
      card("replay-cursor", "Server-side replay cursor", ["sequence-numbers"], "in_review", {
        round: 1,
        lane: replayCursor,
      }),
      card("client-ack", "Client ack and buffer flush", ["sequence-numbers"], "fixing", {
        round: 2,
        lane: clientAck,
      }),
      card("cold-start-replay", "Mobile cold-start replay", ["sequence-numbers"], "escalated", {
        round: 2,
        lane: coldStartReplay,
      }),
      card(
        "soak-test",
        "Reconnect soak test",
        ["replay-cursor", "client-ack", "cold-start-replay"],
        "working",
        { round: 1, lane: soakTest },
      ),
      card("migration-note", "Migration note and docs", ["replay-cursor"], "planned", {
        note: "Starts when its dependencies merge.",
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
        text: "Mobile cold-start replay failed review twice and was escalated.",
      },
      { at: createdAt + 121 * minute, text: "Planner proposed plan revision 2." },
    ],
    pullRequest: null,
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
      title: "Defer the first relay sync failed review twice",
      body: "Deferring the first sync leaves the inbox empty for about 3s after launch, and the reviewer rejects that both times. Approve to accept the delay and keep the lane going, or reject to keep the sync on the startup path.",
      revision: 1,
      changes: [
        {
          kind: "changed",
          cardId: "defer-sync",
          title: "Defer the first relay sync",
          detail: "Accepts a short empty inbox after launch; the reviewer checks the rest.",
        },
      ],
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
      }),
      card("lazy-fonts", "Lazy-load fonts and icons", ["trace"], "working", {
        round: 1,
        lane: coldStartLane("claude-personal", "claude", "Sonnet 4.6, worktree lanes/lazy-fonts"),
      }),
      card("hermes-bytecode", "Precompile Hermes bytecode", ["trace"], "working", {
        round: 1,
        lane: coldStartLane("codex-personal", "codex", "GPT-5.3 Codex, worktree lanes/hermes"),
      }),
      card("defer-sync", "Defer the first relay sync", ["trace"], "escalated", {
        round: 2,
        lane: coldStartLane("opencode", "opencode", "Worktree lanes/defer-sync"),
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
