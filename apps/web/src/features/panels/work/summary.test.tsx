import { dedupeReconnect, facts, multiDayDemo, type Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { agentRow, isBreathing, openWorkPanel } from "@/test/open-work.ts";

beforeEach(() => localStorage.clear());

const file = "/Users/dev/acme/src/panel.ts";
const edit = (agent: string, item: string) =>
  facts.tool(agent, item, {
    kind: "file.edit",
    title: "Edit src/panel.ts",
    detail: {
      kind: "file.edit",
      changes: [{ path: file, kind: "update", diff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" }],
    },
  });

/**
 * The main agent hands an unnamed subagent a task; both edit the same file in the one
 * checkout, the subagent reports back, and the main agent's typecheck fails.
 */
function reviewScenario(): Scenario {
  return {
    thread: {
      id: "thread-summary",
      workspaceId: "acme",
      title: "Split the summary panel",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          facts.message("root", "ask", "user", "Split the summary panel into sections."),
          facts.tool("root", "spawn-helper", {
            kind: "agent.spawn",
            title: "Task",
            detail: {
              kind: "agent.spawn",
              prompt: "Rename the panel helpers\nThen update every caller.",
              childAgent: "helper",
            },
          }),
          {
            type: "agent.seen",
            agent: "helper",
            parent: "root",
            spawnedBy: "spawn-helper",
            origin: "provider_subagent",
            fidelity: "full",
            native: { provider: "claude", nativeId: "helper" },
            cwd: "/Users/dev/acme",
          },
          facts.turn("helper", "spawn"),
          edit("helper", "edit-helper"),
          facts.toolDone("helper", "edit-helper"),
          facts.endTurn("helper"),
          {
            type: "item.upsert",
            agent: "root",
            item: "spawn-helper",
            draft: {
              type: "tool_call",
              complete: true,
              call: {
                status: "succeeded",
                result: {
                  isError: false,
                  durationMs: 5,
                  content: [{ type: "text", text: "Renamed 3 helpers and updated callers." }],
                },
              },
            },
          },
          edit("root", "edit-root"),
          facts.toolDone("root", "edit-root"),
          facts.tool("root", "typecheck", {
            kind: "shell",
            title: "Typecheck",
            detail: { kind: "shell", command: "bun run typecheck", exitCode: 2 },
          }),
          facts.toolDone("root", "typecheck", "failed"),
        ],
      },
    ],
  };
}

async function openReview() {
  const app = harness();
  app.play(reviewScenario()).runUntilBlocked();
  await app.open("/t/thread-summary");
  return { app, work: await openWorkPanel() };
}

test("without a pull request the outcome lists the files changed, the checks as pills, and Review changes", async () => {
  const { work } = await openReview();
  const changes = await within(work).findByRole("region", { name: "Changes" });
  expect(within(changes).getByRole("heading", { name: "1 file changed" })).toBeTruthy();
  // The person's message is the transcript's, not a result.
  expect(within(changes).queryByText("Split the summary panel into sections.")).toBeNull();
  const list = within(changes).getByRole("list", { name: "Files changed" });
  expect(within(list).getByRole("button", { name: file })).toBeTruthy();
  const state = within(changes).getByRole("list", { name: "State" });
  const typecheck = within(state).getByText(/Typecheck/);
  expect(typecheck.closest("li")?.textContent).toBe("Typecheck failed, exit 2");
  expect(typecheck.closest("li")?.getAttribute("data-tone")).toBe("failed");
  expect(within(changes).queryByRole("button", { name: /^Open #/ })).toBeNull();
  await userEvent.click(within(changes).getByRole("button", { name: "Review changes" }));
  expect(await screen.findByRole("tab", { name: /^Changes/, selected: true })).toBeTruthy();
});

test("a finished agent is named by its task and its row says how it ended and opens it", async () => {
  const { work } = await openReview();
  const helper = await agentRow(work, "Rename the panel helpers");
  expect(helper.getAttribute("aria-label")).toBe(
    "Rename the panel helpers: Renamed 3 helpers and updated callers.",
  );
  expect(isBreathing(helper)).toBe(false);
  await userEvent.click(helper);
  expect(
    await screen.findByRole("heading", { level: 1, name: "Rename the panel helpers" }),
  ).toBeTruthy();
});

test("two agents editing the same file in one checkout are flagged", async () => {
  const { work } = await openReview();
  const changes = await within(work).findByRole("region", { name: "Changes" });
  const alert = await within(changes).findByRole("alert");
  await waitFor(() =>
    expect(alert.textContent).toBe(
      "src/panel.ts was changed by Claude Code and Rename the panel helpers in the same checkout",
    ),
  );
});

test("returning to a thread that moved on folds what happened since into one line that opens, until cleared", async () => {
  let now = 10 * 24 * 60 * 60 * 1000;
  const app = harness({ snapshotItems: 40, clock: () => (now += 1) });
  app.play(multiDayDemo("thread-away", 6, { scans: 2 })).runUntilBlocked();
  app.daemon.markReadThrough("thread-away", "answer-3", "test-device");
  await app.open("/t/thread-away");
  const work = await openWorkPanel();
  const since = await within(work).findByRole("region", { name: "Since you looked" });
  // One quiet line until the person opens it in place.
  expect(within(since).getByText(/^\d+ updates? since you looked$/)).toBeTruthy();
  expect(within(since).queryByText(/^\d+ turns finished$/)).toBeNull();
  await userEvent.click(within(since).getByRole("button", { name: "Show" }));
  expect(within(since).getByText(/^\d+ turns finished$/)).toBeTruthy();
  await userEvent.click(within(since).getByRole("button", { name: "Clear" }));
  await waitFor(() =>
    expect(within(work).queryByRole("region", { name: "Since you looked" })).toBeNull(),
  );
});

/** The reconnect fix with its pull request #214, untitled when `title` is false. */
function dedupe(title = true): Scenario {
  const scenario = dedupeReconnect();
  const details = scenario.thread.details;
  if (title || !details) return scenario;
  const linkedPrs = details.linkedPrs?.map(({ title: _title, ...pr }) => pr);
  return { ...scenario, thread: { ...scenario.thread, details: { ...details, linkedPrs } } };
}

async function openDedupe(title = true) {
  const app = harness();
  app.play(dedupe(title)).runUntilBlocked();
  await app.open("/t/thread-dedupe");
  const work = await openWorkPanel();
  return { app, work, pr: await within(work).findByRole("region", { name: "Pull request #214" }) };
}

test("the outcome leads with the pull request: its title once, its checks and files, Review changes and Open", async () => {
  const { work, pr } = await openDedupe();
  expect(within(pr).getByRole("heading").textContent).toBe("Dedupe thread events after reconnect");
  expect(
    within(work).getAllByText("Dedupe thread events after reconnect", { selector: "h3" }),
  ).toHaveLength(1);
  const state = within(pr).getByRole("list", { name: "State" });
  expect(
    within(state)
      .getAllByRole("listitem")
      .map((pill) => pill.textContent),
  ).toEqual(["#214 · In review", "Tests passed", "Typecheck passed"]);
  const files = within(pr).getByRole("list", { name: "Files changed" });
  expect(
    within(files)
      .getAllByRole("button")
      .map((row) => row.getAttribute("aria-label")),
  ).toEqual([expect.stringMatching(/replay-session\.ts$/), expect.stringMatching(/outbox\.ts$/)]);
  // It is the outcome, so the PR isn't listed again under the other pull requests.
  expect(within(work).queryByRole("region", { name: "Other pull requests" })).toBeNull();
  await userEvent.click(within(pr).getByRole("button", { name: "Review changes" }));
  expect(await screen.findByRole("tab", { name: /^Changes/, selected: true })).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
  const again = await within(await openWorkPanel()).findByRole("region", {
    name: "Pull request #214",
  });
  await userEvent.click(within(again).getByRole("button", { name: "Open #214" }));
  expect(await screen.findByRole("tab", { name: /^#214/, selected: true })).toBeTruthy();
});

test("an untitled pull request is named by its number once", async () => {
  const { pr } = await openDedupe(false);
  expect(within(pr).getByRole("heading").textContent).toBe("#214");
  const state = within(pr).getByRole("list", { name: "State" });
  expect(within(state).getAllByRole("listitem")[0]?.textContent).toBe("In review");
  expect(pr.textContent?.match(/#214/g)).toHaveLength(2);
});
