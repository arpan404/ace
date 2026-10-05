import {
  accountLimit,
  delegatedDocs,
  delegatedDocsIds,
  facts,
  permissionAudit,
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

test("a question sits in the transcript where the agent asked it", async () => {
  const app = harness();
  app.play(scenario("thread-sheet-rotate")).runUntilBlocked();
  await app.open("/t/thread-sheet-rotate");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const card = await within(feed).findByRole("article", {
    name: "How should the sheet recover after rotate?",
  });
  const finding = within(feed).getByText(/three ways to fix it/);
  expect(finding.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Once, in place: not again under the transcript.
  expect(
    screen.getAllByRole("article", { name: "How should the sheet recover after rotate?" }),
  ).toHaveLength(1);
});

const { endTurn, message, rootAgent, tool, toolDone, turn } = facts;

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

test("a turn has one live line: an earlier log with a step still running stays Worked for", async () => {
  const app = harness();
  const script = app.play(stuckCommand());
  script.runThrough("second-step");
  await app.open("/t/thread-stuck");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const live = await within(feed).findAllByRole("button", { name: /^Working for/ });
  expect(live).toHaveLength(1);
  const logs = within(feed).getAllByRole("button", { name: /^Work(ed|ing) for/ });
  expect(logs.map((log) => /^Work(ed|ing)/.exec(log.textContent ?? "")?.[0])).toEqual([
    "Worked",
    "Working",
  ]);
  // The live header names the step in flight; no second line under the transcript.
  expect(within(feed).getByText("Reading src/config.ts")).toBeTruthy();
  expect(screen.queryByRole("status", { name: /Work/ })).toBeNull();

  // Once the agent speaks again, the log above freezes and the live line moves to the footer.
  act(() => script.runThrough("answered"));
  await within(feed).findByText("The config reads the lockfile path.");
  expect(within(feed).queryByRole("button", { name: /^Working for/ })).toBeNull();
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

test("ace's review of a step joins that step's log instead of splitting the work", async () => {
  const app = harness();
  app.play(permissionAudit()).runUntilBlocked();
  await app.open("/t/thread-release-audit");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const ask = await within(feed).findByText(/Clean out the old build/);
  const note = await within(feed).findByText(/ace declined deleting dist/);
  const between = within(feed)
    .getAllByRole("button", { name: /^Work(ed|ing) for/ })
    .filter((log) => follows(ask, log) && follows(log, note));
  expect(between).toHaveLength(1);

  const log = between[0]!;
  await userEvent.click(log);
  // Each decision reads once, as the note on the step it judged (IR-2), inside that log.
  const steps = within(log.parentElement!).getByRole("list", { name: "Steps" });
  expect(
    await within(steps).findByRole("button", { name: "Ran pwd Approved by ace · auto-review" }),
  ).toBeTruthy();
  expect(
    within(steps).getByRole("button", { name: "Run rm -rf dist Denied by ace · auto-review" }),
  ).toBeTruthy();
  expect(within(steps).queryByRole("article", { name: /Permission review/ })).toBeNull();
});

function edit(key: string, path: string) {
  return [
    tool("root", key, {
      kind: "file.edit",
      title: `Edit ${path}`,
      detail: {
        kind: "file.edit",
        changes: [{ path, kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
      },
    }),
    toolDone("root", key),
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
  const failed = await within(feed).findByRole("group", { name: "Turn failed" });
  expect(failed.textContent).toContain("2 tests failing on #74");

  await userEvent.click(within(failed).getByRole("button", { name: "Details" }));
  expect(within(failed).getByText("provider: 2 tests failing on #74")).toBeTruthy();

  await userEvent.click(within(failed).getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(within(feed).getAllByText(/Invoices for unsupported locales render empty/)).toHaveLength(
      2,
    ),
  );
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
});

test("a turn stopped before any reply still says so under the ask", async () => {
  const app = harness();
  app.play(stopped(false)).runUntilBlocked();
  await app.open("/t/thread-stopped");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const note = await within(feed).findByRole("note", { name: /^Stopped by you/ });
  expect(follows(within(feed).getByText("Build the release bundle."), note)).toBe(true);
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

test("a usage-limit pause marks where the turn stopped", async () => {
  const app = harness();
  app
    .play(accountLimit("thread-limit-flags", "Remove the legacy feature-flag reader"))
    .runUntilBlocked();
  await app.open("/t/thread-limit-flags");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const pause = await screen.findByRole("status", {
    name: "Paused · Codex usage limit · reset time unknown",
  });
  expect(follows(within(feed).getByText("Remove the legacy feature-flag reader"), pause)).toBe(
    true,
  );
});
