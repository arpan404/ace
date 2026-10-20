import { facts, multiDayDemo, type Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openDoneAgents, openWorkPanel } from "@/test/open-work.ts";

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

test("this turn says what happened, not the person's message, each count opening its list", async () => {
  const { work } = await openReview();
  const turn = await within(work).findByRole("region", { name: "This turn" });
  expect(within(turn).queryByText("Split the summary panel into sections.")).toBeNull();
  const commands = await within(turn).findByRole("button", { name: /^1 command, 1 failed/ });
  await userEvent.click(within(turn).getByRole("button", { name: /^1 file changed/ }));
  const files = within(turn).getByRole("list", { name: "Files changed" });
  expect(within(files).getByRole("button", { name: file })).toBeTruthy();
  await userEvent.click(commands);
  const list = within(turn).getByRole("list", { name: "Commands" });
  expect(within(list).getByRole("listitem", { name: "bun run typecheck: failed" })).toBeTruthy();
  // One list at a time.
  expect(within(turn).queryByRole("list", { name: "Files changed" })).toBeNull();
});

test("a finished agent is named by its task and shows its result line and files touched", async () => {
  const { work } = await openReview();
  const done = await openDoneAgents(work);
  const helper = await within(done).findByRole("treeitem", {
    name: "Rename the panel helpers: Idle",
  });
  expect(helper.textContent).not.toMatch(/Subagent/);
  await waitFor(() =>
    expect(helper.textContent).toContain("Renamed 3 helpers and updated callers. · 1 file"),
  );
  const row = helper.parentElement as HTMLElement;
  expect(
    within(row).getByRole("button", { name: "Diff of Rename the panel helpers" }),
  ).toBeTruthy();
  await userEvent.click(within(row).getByRole("button", { name: "Open Rename the panel helpers" }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Rename the panel helpers" }),
  ).toBeTruthy();
});

test("two agents editing the same file in one worktree are flagged", async () => {
  const { work } = await openReview();
  const changes = await within(work).findByRole("region", { name: "Changes by agent" });
  const alert = within(changes).getByRole("alert");
  await waitFor(() =>
    expect(alert.textContent).toBe(
      "src/panel.ts was changed by Claude Code and Rename the panel helpers in the same checkout",
    ),
  );
  expect(
    within(changes).getAllByRole("button", {
      name: "src/panel.ts, also changed by another agent",
    }),
  ).toHaveLength(2);
});

test("a failed typecheck shows under Checks", async () => {
  const { work } = await openReview();
  const checks = await within(work).findByRole("region", { name: "Checks" });
  const typecheck = within(checks).getByRole("listitem", { name: "Typecheck: Failed" });
  expect(typecheck.textContent).toContain("exit 2");
  expect(typecheck.textContent).toContain("bun run typecheck");
});

test("returning to a thread that moved on shows what happened since, until dismissed", async () => {
  let now = 10 * 24 * 60 * 60 * 1000;
  const app = harness({ snapshotItems: 40, clock: () => (now += 1) });
  app.play(multiDayDemo("thread-away", 6, { scans: 2 })).runUntilBlocked();
  app.daemon.markReadThrough("thread-away", "answer-3", "test-device");
  await app.open("/t/thread-away");
  const work = await openWorkPanel();
  const since = await within(work).findByRole("region", { name: "Since you last looked" });
  expect(since.textContent).toMatch(/\d+ turns finished/);
  await userEvent.click(within(since).getByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    expect(within(work).queryByRole("region", { name: "Since you last looked" })).toBeNull(),
  );
});
