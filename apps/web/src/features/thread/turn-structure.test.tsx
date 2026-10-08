import {
  accountLimit,
  delegatedDocs,
  delegatedDocsIds,
  facts,
  workbench,
  type Scenario,
} from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

function scenario(id: string) {
  const found = workbench().find((candidate) => candidate.thread.id === id);
  if (!found) throw new Error(`workbench lost ${id}`);
  return found;
}

test("a question keeps its line in the transcript where the agent asked it, and is answered once, on the composer", async () => {
  const app = harness();
  app.play(scenario("thread-sheet-rotate")).runUntilBlocked();
  await app.open("/t/thread-sheet-rotate");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const line = await within(feed).findByRole("group", {
    name: "Question: How should the sheet recover after rotate?",
  });
  const finding = await within(feed).findByText(/three ways to fix it/);
  expect(finding.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The card to answer it is on the composer, once, and nowhere in the transcript.
  const deck = await screen.findByRole("region", { name: "Waiting for you" });
  expect(
    await within(deck).findByRole("article", {
      name: "How should the sheet recover after rotate?",
    }),
  ).toBeTruthy();
  expect(
    screen.getAllByRole("article", { name: "How should the sheet recover after rotate?" }),
  ).toHaveLength(1);
  expect(within(feed).queryByRole("radio")).toBeNull();
});

const { endTurn, message, rootAgent, subagent, tool, toolDone, turn } = facts;

const follows = (a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** A turn whose first command never settles, then a progress note and a second step. */
function stuckCommand(): Scenario {
  return {
    thread: {
      id: "thread-stuck",
      workspaceId: "ace",
      title: "Install and read",
      provider: "codex",
    },
    steps: [
      {
        kind: "facts",
        label: "second-step",
        facts: [
          rootAgent("codex"),
          turn("root"),
          message("root", "ask", "user", "Install the deps and read the config."),
          tool("root", "install", {
            kind: "shell",
            title: "bun install",
            detail: { kind: "shell", command: "bun install --frozen-lockfile" },
          }),
          message("root", "progress", "assistant", "Installing; reading the config meanwhile."),
          tool("root", "read", {
            kind: "file.read",
            title: "Read src/config.ts",
            detail: { kind: "file.read", path: "src/config.ts" },
          }),
        ],
      },
      {
        kind: "facts",
        label: "answered",
        facts: [message("root", "answer", "assistant", "The config reads the lockfile path.")],
      },
    ],
  };
}

test("a turn is one log: a note between steps reads inside it, and it carries the live line", async () => {
  const app = harness();
  const script = app.play(stuckCommand());
  script.runThrough("second-step");
  await app.open("/t/thread-stuck");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const logs = await within(feed).findAllByRole("button", { name: /^Work(ed|ing) for/ });
  expect(logs).toHaveLength(1);
  expect(logs[0]!.textContent).toMatch(/^Working for/);
  // The live header names the step in flight; no second line under the transcript.
  expect(within(feed).getByText("Reading src/config.ts")).toBeTruthy();
  expect(screen.queryByRole("status", { name: /Work/ })).toBeNull();
  // The note the agent wrote between the two steps is in the log, between them.
  expect(within(feed).queryByText("Installing; reading the config meanwhile.")).toBeNull();
  await userEvent.click(logs[0]!);
  const steps = await within(feed).findByRole("list", { name: "Steps" });
  const note = await within(steps).findByText("Installing; reading the config meanwhile.");
  expect(follows(within(steps).getByRole("button", { name: /^Running bun install/ }), note)).toBe(
    true,
  );
  expect(follows(note, within(steps).getByRole("button", { name: /^Reading src\/config/ }))).toBe(
    true,
  );

  // Once the agent answers, the answer reads below the log, the log is history and the live
  // line moves to the footer (the install still runs).
  act(() => script.runThrough("answered"));
  const answer = await within(feed).findByText("The config reads the lockfile path.");
  expect(within(feed).queryByRole("button", { name: /^Working for/ })).toBeNull();
  expect(follows(within(feed).getByRole("button", { name: /^Work so far/ }), answer)).toBe(true);
  expect(within(feed).queryByRole("button", { name: /^Worked for/ })).toBeNull();
  expect(await screen.findByRole("status", { name: "Working" })).toBeTruthy();
});

test("while a step waits for approval nothing says Working: the line says it waits on you", async () => {
  const app = harness();
  app.play(scenario("thread-retry-budget")).runUntilBlocked();
  await app.open("/t/thread-retry-budget");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const line = await screen.findByRole("status", { name: "Waiting for your approval" });
  expect(line.textContent).not.toMatch(/\d+s/);
  expect(within(feed).queryByRole("button", { name: /^Working for/ })).toBeNull();
  // The waiting step says so on its own row (IR-2's wording).
  expect(
    await within(feed).findByRole("button", {
      name: /^Run git push .* Waiting for your approval$/,
    }),
  ).toBeTruthy();
});

function edit(key: string, path: string, agent = "root") {
  return [
    tool(agent, key, {
      kind: "file.edit",
      title: `Edit ${path}`,
      detail: {
        kind: "file.edit",
        changes: [{ path, kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
      },
    }),
    toolDone(agent, key),
  ];
}

/** One turn that edits, says how it is going, edits again and answers. */
function twoEdits(): Scenario {
  return {
    thread: {
      id: "thread-edits",
      workspaceId: "ace",
      title: "Rename the flag",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        label: "answered",
        facts: [
          rootAgent("claude"),
          turn("root"),
          message("root", "ask", "user", "Rename the legacy flag everywhere."),
          ...edit("edit-a", "src/flags.ts"),
          message("root", "progress", "assistant", "Renamed the definition; now the callers."),
          ...edit("edit-b", "src/app.ts"),
          message("root", "answer", "assistant", "Renamed in both files."),
        ],
      },
      { kind: "facts", label: "ended", facts: [endTurn("root")] },
    ],
  };
}

test("a turn's changed files show once, after its last answer, when it has ended", async () => {
  const app = harness();
  const script = app.play(twoEdits());
  script.runThrough("answered");
  await app.open("/t/thread-edits");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Renamed in both files.");
  expect(within(feed).queryByRole("region", { name: /changed file/ })).toBeNull();

  act(() => script.runThrough("ended"));
  const card = await within(feed).findByRole("region", { name: "2 changed files" });
  expect(within(feed).getAllByRole("region", { name: /changed file/ })).toHaveLength(1);
  expect(follows(within(feed).getByText("Renamed in both files."), card)).toBe(true);
});

test("a failed turn ends with its reason, and Retry sends the ask again", async () => {
  const app = harness();
  app.play(scenario("thread-pdf-locale")).runUntilBlocked();
  await app.open("/t/thread-pdf-locale");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const failed = await within(feed).findByRole("group", { name: /^Turn failed/ });
  expect(failed.textContent).toContain("2 tests failing on #74");

  await userEvent.click(within(failed).getByRole("button", { name: "Details" }));
  expect(within(failed).getByText("provider: 2 tests failing on #74")).toBeTruthy();

  await userEvent.click(within(failed).getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(within(feed).getAllByText(/Invoices for unsupported locales render empty/)).toHaveLength(
      2,
    ),
  );
  // The retried turn is history now: it keeps its reason, without offering Retry again.
  const kept = within(feed).getByRole("group", { name: /^Turn failed/ });
  expect(kept.textContent).toContain("2 tests failing on #74");
  expect(within(kept).queryByRole("button", { name: "Retry" })).toBeNull();
});

function stopped(withWork: boolean): Scenario {
  return {
    thread: { id: "thread-stopped", workspaceId: "ace", title: "Long build", provider: "claude" },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("claude"),
          turn("root"),
          message("root", "ask", "user", "Build the release bundle."),
          ...(withWork
            ? [
                tool("root", "build", {
                  kind: "shell",
                  title: "bun run build",
                  detail: { kind: "shell", command: "bun run build" },
                }),
                message("root", "partial", "assistant", "Building the web bundle first", false),
              ]
            : []),
          endTurn("root", "interrupted"),
        ],
      },
    ],
  };
}

test("a stopped turn says so under what it got done", async () => {
  const app = harness();
  app.play(stopped(true)).runUntilBlocked();
  await app.open("/t/thread-stopped");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const note = await within(feed).findByRole("note", { name: /^Stopped by you/ });
  expect(follows(within(feed).getByText("Building the web bundle first"), note)).toBe(true);
  // What it had written stays, but no longer looks like it is still being written.
  expect(within(feed).queryByRole("status", { name: "Streaming" })).toBeNull();
});

test("a turn stopped before any reply keeps saying so under its ask after the next ask", async () => {
  const app = harness();
  app.play(stopped(false)).runUntilBlocked();
  await app.open("/t/thread-stopped");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const note = await within(feed).findByRole("note", { name: /^Stopped by you/ });
  expect(follows(within(feed).getByText("Build the release bundle."), note)).toBe(true);

  act(() =>
    app.daemon.apply("thread-stopped", [
      { type: "turn.started", agent: "root", nativeTurnId: "turn-2", trigger: "user" },
      message("root", "ask-2", "user", "Build only the web bundle."),
    ]),
  );
  const next = await within(feed).findByText("Build only the web bundle.");
  const kept = within(feed).getByRole("note", { name: /^Stopped by you/ });
  expect(follows(within(feed).getByText("Build the release bundle."), kept)).toBe(true);
  expect(follows(kept, next)).toBe(true);
});

test("the subagents line opens to the agents started, with their model, and opens a delegate's thread", async () => {
  const app = harness();
  for (const thread of delegatedDocs()) app.play(thread).runUntilBlocked();
  await app.open(`/t/${delegatedDocsIds.parent}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(await within(feed).findByRole("button", { name: "Started 1 subagent" }));
  const tree = within(feed).getByRole("tree", { name: "Subagents" });
  const [row] = within(tree).getAllByRole("treeitem");
  expect(row?.getAttribute("aria-label")).toMatch(/^protocol-docs: /);
  expect(row?.textContent).toContain("Codex · gpt-5.5-codex");

  await userEvent.click(within(tree).getByRole("link", { name: "Open protocol-docs's thread" }));
  expect(await screen.findByText(/Drafted the frame table/)).toBeTruthy();
});

test("a usage-limit pause marks where the turn stopped, and stays there after the resume", async () => {
  const app = harness();
  app
    .play(accountLimit("thread-limit-flags", "Remove the legacy feature-flag reader"))
    .runUntilBlocked();
  await app.open("/t/thread-limit-flags");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const pause = await within(feed).findByRole("note", {
    name: "Paused · Codex usage limit · reset time unknown",
  });
  const ask = within(feed).getByText("Remove the legacy feature-flag reader");
  expect(follows(ask, pause)).toBe(true);
  // One marker: the live line doesn't repeat it.
  expect(screen.queryByRole("status", { name: /^Paused/ })).toBeNull();

  act(() => app.daemon.apply("thread-limit-flags", resumeAfterLimit));
  const resumed = await within(feed).findByText("Picking the flag removal back up.");
  const kept = within(feed).getByRole("note", { name: "Paused · Codex usage limit" });
  expect(follows(ask, kept) && follows(kept, resumed)).toBe(true);
});

const resumeAfterLimit = [
  { type: "limit.cleared", agent: "root" } as const,
  { type: "turn.started", agent: "root", nativeTurnId: "resume", trigger: "limit_resume" } as const,
  message("root", "resumed", "assistant", "Picking the flag removal back up."),
];

test("a pause in history is rebuilt from the resume, after a reload", async () => {
  const app = harness();
  const script = app.play(
    accountLimit("thread-limit-flags", "Remove the legacy feature-flag reader"),
  );
  script.runUntilBlocked();
  app.daemon.apply("thread-limit-flags", resumeAfterLimit);
  await app.open("/t/thread-limit-flags");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const pause = await within(feed).findByRole("note", { name: "Paused · Codex usage limit" });
  expect(follows(pause, within(feed).getByText("Picking the flag removal back up."))).toBe(true);
  // The resume interrupted the paused turn; the pause already says why it stopped.
  expect(within(feed).queryByRole("note", { name: /^Stopped/ })).toBeNull();
});

test("the changed-files card waits until the subagents a turn started have finished too", async () => {
  const app = harness();
  const script = app.play({
    thread: {
      id: "thread-tree",
      workspaceId: "ace",
      title: "Rename with help",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        label: "root-done",
        facts: [
          rootAgent("claude"),
          turn("root"),
          message("root", "ask", "user", "Rename the flag; have a subagent fix the tests."),
          tool("root", "spawn-tests", {
            kind: "agent.spawn",
            title: "Fix the tests",
            detail: { kind: "agent.spawn", description: "Fix the tests", childAgent: "tests" },
          }),
          subagent("claude", "tests", "tests", "spawn-tests"),
          turn("tests"),
          ...edit("edit-test", "src/flags.test.ts", "tests"),
          ...edit("edit-root", "src/flags.ts"),
          message("root", "answer", "assistant", "Renamed; the subagent is finishing the tests."),
          endTurn("root"),
        ],
      },
      {
        kind: "facts",
        label: "tree-done",
        facts: [...edit("edit-test-2", "src/app.test.ts", "tests"), endTurn("tests")],
      },
    ],
  });
  script.runThrough("root-done");
  await app.open("/t/thread-tree");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Renamed; the subagent is finishing the tests.");
  expect(within(feed).queryByRole("region", { name: /changed file/ })).toBeNull();

  // The subagent's run ends on its own: that alone settles the turn.
  act(() => script.runThrough("tree-done"));
  expect(await within(feed).findByRole("region", { name: "3 changed files" })).toBeTruthy();
});

test("the step in flight on the live line follows the step's own updates", async () => {
  const app = harness();
  app
    .play({
      thread: {
        id: "thread-run",
        workspaceId: "ace",
        title: "Build the web app",
        provider: "codex",
      },
      steps: [
        {
          kind: "facts",
          facts: [
            rootAgent("codex"),
            turn("root"),
            message("root", "ask", "user", "Build the web app."),
            tool("root", "tests", {
              kind: "shell",
              title: "bun run build",
              detail: { kind: "shell", command: "bun run build" },
            }),
          ],
        },
      ],
    })
    .runUntilBlocked();
  await app.open("/t/thread-run");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Running bun run build");

  // The provider refines the command; the agent's own status doesn't change.
  act(() =>
    app.daemon.apply("thread-run", [
      {
        type: "item.upsert",
        agent: "root",
        item: "tests",
        draft: {
          type: "tool_call",
          call: { detail: { kind: "shell", command: "bun run build apps/web" } },
        },
      },
    ]),
  );
  expect(await within(feed).findByText("Running bun run build apps/web")).toBeTruthy();
});

test("an open turn shows one live timer; its closed log becomes timed history only when the turn settles", async () => {
  let now = 1_000;
  const app = harness({ clock: () => now });
  const script = app.play({
    thread: { id: "thread-frozen", workspaceId: "ace", title: "Build", provider: "claude" },
    steps: [
      {
        kind: "facts",
        label: "started",
        facts: [
          rootAgent("claude"),
          turn("root"),
          message("root", "ask", "user", "Build it."),
          tool("root", "build", {
            kind: "shell",
            title: "bun run build",
            detail: { kind: "shell", command: "bun run build" },
          }),
        ],
      },
      {
        kind: "facts",
        label: "spoke",
        facts: [message("root", "note", "assistant", "The build runs; meanwhile, the docs.")],
      },
      { kind: "facts", label: "settled", facts: [toolDone("root", "build"), endTurn("root")] },
    ],
  });
  script.runThrough("started");
  now = 11_000;
  script.runThrough("spoke");
  await app.open("/t/thread-frozen");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByRole("button", { name: /^Work so far/ })).toBeTruthy();
  expect(within(feed).queryByRole("button", { name: /^Worked for/ })).toBeNull();
  expect(await screen.findByRole("status", { name: "Working" })).toBeTruthy();
  const timers = screen.getAllByText(/^Working for/);
  expect(timers).toHaveLength(1);

  now = 101_000;
  act(() => script.runThrough("settled"));
  await waitFor(() =>
    expect(
      within(feed).getByRole("button", { name: /Ran bun run build|^Worked for/ }),
    ).toBeTruthy(),
  );
  expect(within(feed).getByRole("button", { name: /^Worked for 10s/ })).toBeTruthy();
});

test("a question still waiting in an old turn keeps that turn open in a long thread", async () => {
  const app = harness();
  type Facts = Parameters<typeof app.daemon.apply>[1][number][];
  // One step per turn, so each turn happens at its own time.
  const turns: Facts[] = [];
  for (let n = 1; n <= 14; n++) {
    const steps: Facts = n === 1 ? [rootAgent("claude")] : [];
    turns.push(steps);
    steps.push(
      { type: "turn.started", agent: "root", nativeTurnId: `t${n}`, trigger: "user" },
      message("root", `ask-${n}`, "user", `Question ${n}`),
    );
    if (n === 1)
      steps.push({
        type: "interaction.opened",
        agent: "root",
        interaction: "keep-reader",
        blocking: false,
        request: {
          kind: "question",
          questions: [
            {
              id: "keep",
              text: "Keep the legacy flag reader?",
              multiSelect: false,
              allowOther: false,
              options: [
                { id: "yes", label: "Keep it" },
                { id: "no", label: "Remove it" },
              ],
            },
          ],
        },
      });
    steps.push(message("root", `answer-${n}`, "assistant", `Answer ${n}`), {
      type: "turn.ended",
      agent: "root",
      nativeTurnId: `t${n}`,
      outcome: "completed",
    });
  }
  app
    .play({
      thread: { id: "thread-old-question", workspaceId: "ace", title: "Flags", provider: "claude" },
      steps: turns.map((list) => ({ kind: "facts" as const, facts: list })),
    })
    .runUntilBlocked();
  await app.open("/t/thread-old-question");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  // Fourteen turns: the older ones fold, but not the one whose question still waits.
  expect(
    await within(feed).findByRole("button", { name: /^Turn 2: Question 2\. Show the turn$/ }),
  ).toBeTruthy();
  expect(
    await within(feed).findByRole("group", { name: "Question: Keep the legacy flag reader?" }),
  ).toBeTruthy();
  expect(within(feed).getByText("Answer 1")).toBeTruthy();
});

test("a finished child with no spawn link does not claim the active parent's turn has worked", async () => {
  let now = 1000;
  const app = harness({ clock: () => now });
  const script = app.play({
    thread: {
      id: "thread-unlinked",
      workspaceId: "ace",
      provider: "claude",
      title: "Partial subagent stream",
    },
    steps: [
      {
        kind: "facts",
        label: "started",
        facts: [
          rootAgent("claude"),
          turn("root"),
          {
            type: "agent.seen",
            agent: "child",
            parent: "root",
            origin: "provider_subagent",
            fidelity: "full",
            native: { provider: "claude", nativeId: "child" },
            cwd: "/fake/ace",
          },
          turn("child"),
          tool("child", "read", {
            kind: "file.read",
            title: "Read policy.ts",
            detail: { kind: "file.read", path: "policy.ts" },
          }),
        ],
      },
      {
        kind: "facts",
        label: "child-finished",
        facts: [
          toolDone("child", "read"),
          message("child", "answer", "assistant", "Policy checked."),
          endTurn("child"),
        ],
      },
    ],
  });
  script.runThrough("started");
  now = 5000;
  script.runThrough("child-finished");
  await app.open("/t/thread-unlinked");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByRole("button", { name: /^Work so far/ })).toBeTruthy();
  expect(within(feed).queryByRole("button", { name: /^Worked for/ })).toBeNull();
  expect(await screen.findByRole("status", { name: "Working" })).toBeTruthy();
  act(() => app.daemon.apply("thread-unlinked", [endTurn("root")]));
  expect(await within(feed).findByRole("button", { name: /^Worked for 4s/ })).toBeTruthy();
});
