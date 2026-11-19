import { facts, multiDayDemo, type Scenario } from "@ace/fake-daemon";
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

test("Results show the files changed and who changed them, and the checks in words", async () => {
  const { work } = await openReview();
  const results = await within(work).findByRole("region", { name: "Results" });
  const files = await within(results).findByRole("button", { name: "1 file changed" });
  await waitFor(() =>
    expect(files.parentElement?.textContent).toMatch(
      /by Claude Code \(1\) and Rename the panel helpers \(1\)/,
    ),
  );
  // The person's message is the transcript's, not a result.
  expect(within(results).queryByText("Split the summary panel into sections.")).toBeNull();
  await userEvent.click(files);
  const list = within(results).getByRole("list", { name: "Files changed" });
  expect(within(list).getByRole("button", { name: file })).toBeTruthy();
  const checks = within(results).getByRole("listitem", { name: "Checks" });
  expect(checks.textContent).toBe("Typecheck failed · exit 2");
  await userEvent.click(within(results).getByRole("button", { name: "Review changes" }));
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
  const results = await within(work).findByRole("region", { name: "Results" });
  const alert = await within(results).findByRole("alert");
  await waitFor(() =>
    expect(alert.textContent).toBe(
      "src/panel.ts was changed by Claude Code and Rename the panel helpers in the same checkout",
    ),
  );
});

test("returning to a thread that moved on shows what happened since, until cleared", async () => {
  let now = 10 * 24 * 60 * 60 * 1000;
  const app = harness({ snapshotItems: 40, clock: () => (now += 1) });
  app.play(multiDayDemo("thread-away", 6, { scans: 2 })).runUntilBlocked();
  app.daemon.markReadThrough("thread-away", "answer-3", "test-device");
  await app.open("/t/thread-away");
  const work = await openWorkPanel();
  const since = await within(work).findByRole("region", { name: "Since you looked" });
  expect(within(since).getByText(/^\d+ turns finished$/)).toBeTruthy();
  await userEvent.click(within(since).getByRole("button", { name: "Clear" }));
  await waitFor(() =>
    expect(within(work).queryByRole("region", { name: "Since you looked" })).toBeNull(),
  );
});
