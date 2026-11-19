import type { FakeDaemon, FakeSpadeApi } from "@ace/fake-daemon";

/*
 * PR watcher's work in the fake Spade: a goal the check sent back, its plan with evidence,
 * two bots it made (one working, one done) with a Codex thread under the first, a Claude Code
 * thread waiting on the person, and two choices it made for them. The Work tab shows every state
 * from it.
 */
export function seedFakeWork(
  daemon: FakeDaemon,
  here: FakeSpadeApi,
  minutes: (n: number) => number,
) {
  const watcher = here.addAgent({
    id: "pr-watcher",
    name: "PR watcher",
    task: "Watch arpan404/ace. Each weekday morning, tell me which pull requests need my review and why CI failed, in a few lines.",
    state: "working",
    status: "Reading the Linux log of run 18240117",
    last_activity: minutes(2),
    spending: {
      today_micros: 2_840_000,
      month_micros: 2_840_000,
    },
  });
  const say = (text: string) => here.store(watcher.conversation, { type: "user_message", text });
  say("get the relay PR green on linux and merged this week");
  here.reply(
    watcher,
    "I'll start with the Linux failure on #2081, fix the test, get both CI runs green, then ask you for a review.",
  );
  here.store(watcher.conversation, {
    type: "decision_made",
    decision: "d1",
    call_id: "c-d1",
    choice: "Left the macOS runner on the real clock",
    reason: "Only the Linux run is slow enough to time out; changing both doubles the diff.",
    options: ["Fake clock on both runners"],
  });
  here.store(watcher.conversation, {
    type: "decision_made",
    decision: "d2",
    call_id: "c-d2",
    choice: "Rebased #2081 on main instead of merging main in",
    reason: "The branch had no merge commits, and you asked for a clean history in July.",
    options: ["Merge main in"],
  });
  here.reply(
    watcher,
    "The check is right: run 18240117 on Linux timed out again. The macOS run was the green one. I'm reading the Linux log now.",
  );
  here.store(watcher.conversation, { type: "reply_started", reply: "r-watcher-now" });
  here.work.setTask("pr-watcher", {
    goal: {
      id: "g1",
      title: "Get #2081 merged",
      text: "get the relay PR green on linux and merged this week",
      criteria: [
        { id: "1", text: "CI passes on Linux and macOS for #2081" },
        { id: "2", text: "The handshake test uses the fake clock" },
        { id: "3", text: "#2081 has an approving review" },
      ],
      by: "bot",
    },
    items: [
      {
        id: "1",
        text: "Reproduce the Linux failure",
        status: "done",
        verified: true,
        split: false,
        evidence: [{ kind: "url", url: "https://github.com/arpan404/ace/actions/runs/18234411" }],
      },
      {
        id: "2",
        text: "Make the handshake test use the fake clock",
        status: "done",
        verified: true,
        split: true,
        evidence: [{ kind: "file", path: "packages/relay/src/noise.test.ts" }],
      },
      {
        id: "2.1",
        parent: "2",
        text: "Swap the real sleep for clock.advance",
        status: "done",
        verified: true,
        split: false,
        evidence: [{ kind: "file", path: "packages/relay/src/noise.test.ts" }],
      },
      {
        id: "2.2",
        parent: "2",
        text: "Run the relay tests here",
        status: "done",
        verified: false,
        split: false,
        evidence: [{ kind: "output", call: "c-tests" }],
      },
      {
        id: "3",
        text: "Get CI green on Linux and macOS",
        status: "working",
        verified: false,
        split: false,
        reason: "run 18240117 still fails on Linux",
      },
      {
        id: "4",
        text: "Ask for a review",
        status: "blocked",
        verified: false,
        split: false,
        reason: "Waits on your review",
      },
    ],
    verdict: {
      claim: "k1",
      finding: "not_yet",
      criteria: [
        {
          id: "1",
          met: false,
          why: "Linux run 18240117 failed: the handshake test timed out again.",
        },
        { id: "2", met: true, why: "" },
        { id: "3", met: false, why: "No review yet." },
      ],
      rejected: [],
      missing: ["Linux CI still fails"],
    },
    progress: { state: "not_yet" },
  });

  // Its workers: a bot reproducing the failure, one done, and ace threads.
  const repro = here.addAgent({
    id: "linux-repro",
    name: "Linux repro",
    task: "Reproduce the Linux failure of #2081's relay test on Ubuntu 24.04 and find why it times out there and not on macOS.",
    state: "working",
    status: "Running the relay tests on Ubuntu",
    parent: { id: "pr-watcher", name: "PR watcher" },
    last_activity: minutes(4),
    spending: {
      today_micros: 840_000,
      month_micros: 840_000,
    },
  });
  // A worker's chat opens with its maker's brief, in the maker's name.
  here.store(repro.conversation, {
    type: "user_message",
    text: "Reproduce #2081's Linux failure. The relay handshake test times out on the Ubuntu runner only (run 18234411). Find why. Return the cause with the run or command that shows it. Don't change the branch; Codex is on the fix once you know the cause.",
    from_agent: { id: "pr-watcher", name: "PR watcher", depth: 1 },
  });
  here.reply(repro, "Starting on a fresh Ubuntu 24.04 container.");
  here.store(repro.conversation, { type: "reply_started", reply: "r-repro-now" });
  here.status(repro, "working", "Running the relay tests on Ubuntu");
  here.addAgent({
    id: "changelog",
    name: "Changelog",
    task: "Draft the release notes for the relay changes.",
    parent: { id: "pr-watcher", name: "PR watcher" },
    last_activity: minutes(30),
    spending: {
      today_micros: 610_000,
      month_micros: 610_000,
    },
  });
  here.work.setTask("changelog", {
    goal: {
      id: "g1",
      title: "Draft the notes",
      text: "",
      criteria: [{ id: "1", text: "Drafted" }],
      by: "bot",
    },
    items: [
      { id: "1", text: "Collect", status: "done", verified: true, split: false },
      { id: "2", text: "Draft", status: "done", verified: true, split: false },
      { id: "3", text: "Link", status: "done", verified: true, split: false },
    ],
    verdict: {
      claim: "k",
      finding: "done",
      criteria: [{ id: "1", met: true, why: "" }],
      rejected: [],
      missing: [],
    },
    progress: { state: "done" },
  });
  // ace threads in a project already on this Mac, as Spade's delegate starts them.
  const workspace =
    daemon.projects.list().workspaces.find((each) => each.name === "relay") ??
    daemon.projects.list().workspaces[0];
  const threads = [
    { id: "thread-fix-timer", title: "Fix the handshake timer", provider: "codex" as const },
    { id: "thread-rebase-2081", title: "Rebase #2081 on main", provider: "claude" as const },
  ];
  if (workspace)
    for (const thread of threads)
      daemon.createThread({
        ...thread,
        workspaceId: workspace.id,
        hasSentMessage: true,
        details: { workspace },
      });
  here.work.addAce("linux-repro", {
    id: "thread-fix-timer",
    name: "Fix the handshake timer",
    state: "working",
  });
  here.work.addAce("pr-watcher", {
    id: "thread-rebase-2081",
    name: "Rebase #2081 on main",
    state: "needs_you",
  });
}
