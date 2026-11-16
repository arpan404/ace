import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`, the capability chat pieces on Github watcher (after its transcript): a goal
 * set and checked, a worker made and reporting, a step the review refused folded into its reply,
 * a digest, and the bot asleep until staging settles, all in the minutes after its transcript. Linux repro, its worker, waits out an
 * outage; Release notes asks again for a step the review refused. `rewind` as the transcript's.
 */
export function seedFakeCapabilities(
  here: FakeSpadeApi,
  rewind: (minutes: number) => void,
  now: number,
) {
  const github = here.agents.find((agent) => agent.id === "github");
  if (!github) return;
  const c = github.conversation;
  const lark = here.addAgent({
    id: "lark",
    name: "Linux repro",
    task: "Reproduce #2081's Linux failure and find why it times out there.",
  });
  const release = here.addAgent({
    id: "release",
    name: "Release notes",
    task: "Keep the release notes for the relay work.",
  });

  rewind(4);
  here.store(c, {
    type: "user_message",
    text: "get the relay PR green on linux and merged this week",
  });
  here.store(c, { type: "reply_started", reply: "r-goal" });
  const plan =
    "I'll start with the Linux failure on #2081, fix the test, get both CI runs green, then ask you for a review.";
  here.store(c, { type: "step_finished", reply: "r-goal", text: plan });
  here.store(c, {
    type: "goal_set",
    goal: "g1",
    title: "Get #2081 merged",
    text: "get the relay PR green on linux and merged this week",
    criteria: [],
    by: "bot",
  });
  here.store(c, {
    type: "worker_started",
    worker: "lark",
    kind: "bot",
    name: "Linux repro",
    call: "w1",
  });
  here.store(c, { type: "reply_finished", reply: "r-goal", text: plan });

  rewind(3);
  here.store(c, {
    type: "user_message",
    text: "check whether the other relay tests have the same timer problem",
  });
  here.store(c, { type: "reply_started", reply: "r-ref" });
  here.store(c, {
    type: "step_finished",
    reply: "r-ref",
    text: "",
    calls: [
      { id: "f1", name: "shell", arguments: { command: "gh pr view 2076 --json comments" } },
      { id: "f2", name: "shell", arguments: { command: 'gh pr comment 2076 --body "…"' } },
      { id: "f3", name: "workspace_read", arguments: { path: "packages/relay/src/peer.test.ts" } },
    ],
  });
  here.store(c, {
    type: "tool_finished",
    reply: "r-ref",
    call_id: "f1",
    name: "shell",
    content: "",
  });
  here.store(c, {
    type: "call_reviewed",
    reply: "r-ref",
    call_id: "f2",
    name: "shell",
    verdict: "refuse",
    reason: "you asked about #2081, not #2076",
    model: "review",
  });
  here.store(c, {
    type: "tool_finished",
    reply: "r-ref",
    call_id: "f2",
    name: "shell",
    content: "Not run: you asked about #2081, not #2076",
  });
  here.store(c, {
    type: "tool_finished",
    reply: "r-ref",
    call_id: "f3",
    name: "workspace_read",
    content: "",
  });
  const found =
    "**#2076** has the same pattern in `peer.test.ts`. I wanted to point it out on that pull request, but the review stopped me.";
  here.store(c, { type: "step_finished", reply: "r-ref", text: found });
  here.store(c, { type: "reply_finished", reply: "r-ref", text: found });

  rewind(2);
  here.store(c, {
    type: "worker_reported",
    worker: "lark",
    kind: "bot",
    name: "Linux repro",
    state: "done",
    epoch: "e1",
    summary: "Linux repro is done.",
  });
  here.store(c, {
    type: "task_verified",
    goal: "g1",
    claim: "t1",
    verdict: "not_yet",
    missing: ["Linux CI still fails"],
  });

  here.wakes.digests.push({
    id: "dg1",
    agent: "github",
    kind: "tree",
    scheduled: true,
    from_ms: now - 24 * 3_600_000,
    to_ms: now - 90_000,
    made_ms: now - 90_000,
    text: "Get #2081 merged: 4 of 6 verified",
    polished: null,
    digest: {
      agent: "github",
      name: "Github watcher",
      quiet: false,
      progress: { title: "Get #2081 merged", state: "not_yet", items_total: 6, items_verified: 4 },
      changed: [
        { at_ms: now - 3 * 3_600_000, text: "Verified: the Linux failure is reproduced" },
        { at_ms: now - 3 * 3_600_000, text: "Not yet: CI on Linux still fails (run 18240117)" },
      ],
      decisions: [
        { at_ms: now, decision: "d1", choice: "Rebased on main instead of merging main in" },
      ],
      spend: { total_micros: 1_420_000, by_role: {} },
      next: ["Rerun Linux CI once the timer fix lands"],
      waiting: [{ level: "block", what: "a review of #2081", since_ms: now }],
      blocked: [],
      workers: [
        {
          agent: "lark",
          name: "Linux repro",
          quiet: false,
          progress: { title: "Reproduce", state: "done", items_total: 3, items_verified: 3 },
          changed: [],
          workers: [],
        },
      ],
      subtree_spend_micros: 3_960_000,
    },
  });

  rewind(1);
  here.store(c, {
    type: "user_message",
    text: "deploy the relay to staging and tell me if the handshake holds",
  });
  const deploy =
    "Deploy started. Staging takes about 15 minutes to settle, so I'll look again then rather than poll.";
  here.store(c, { type: "reply_started", reply: "r-sleep" });
  here.store(c, { type: "step_finished", reply: "r-sleep", text: deploy });
  here.store(c, {
    type: "wake_set",
    wake: "k-sleep",
    reply: "r-sleep",
    purpose: { kind: "sleep" },
    due_ms: now + 15 * 60_000,
    reason: "staging settles",
  });
  here.store(c, { type: "reply_finished", reply: "r-sleep", text: deploy });

  // The worker, mid-turn, waiting out its endpoint's outage.
  rewind(20);
  here.store(lark.conversation, {
    type: "user_message",
    text: "Reproduce #2081's Linux failure on Ubuntu 24.04 and find why it times out there.",
    from_agent: { id: "github", name: "Github watcher" },
  });
  here.store(lark.conversation, { type: "reply_started", reply: "r-lark" });
  here.store(lark.conversation, {
    type: "wake_set",
    wake: "k-out",
    reply: "r-lark",
    purpose: { kind: "outage", attempt: 3, error: "503" },
    due_ms: now + 4 * 60_000,
  });

  // A step the review refused, asked again: the card leads with the first refusal.
  rewind(6);
  const r = release.conversation;
  here.store(r, { type: "user_message", text: "tell the #2076 thread the fix applies there too" });
  here.store(r, { type: "reply_started", reply: "r-rel" });
  here.store(r, {
    type: "step_finished",
    reply: "r-rel",
    text: "I'll comment on #2076.",
    calls: [
      {
        id: "x1",
        name: "shell",
        arguments: {
          command: 'gh pr comment 2076 --body "The same fake-clock fix applies to peer.test.ts."',
        },
      },
    ],
  });
  here.store(r, {
    type: "approval_requested",
    reply: "r-rel",
    call_id: "x1",
    name: "shell",
    arguments: {
      command: 'gh pr comment 2076 --body "The same fake-clock fix applies to peer.test.ts."',
    },
    reviewer_reason: "Refused again: you asked about #2081, not #2076",
  });
  here.status(release, "waiting", null);
  rewind(0);
}
