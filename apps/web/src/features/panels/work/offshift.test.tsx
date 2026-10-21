import { facts, type Scenario } from "@ace/fake-daemon";
import type { OffshiftRunCard } from "@ace/protocol/offshift";
import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openWorkPanel } from "@/test/open-work.ts";

beforeEach(() => localStorage.clear());

const criterion = "Bad password shows an error";
function card(overrides: Partial<OffshiftRunCard>): OffshiftRunCard {
  return {
    id: "login",
    outcome: "The login page shows a helpful error",
    outcomeTruncated: false,
    endpoint: "Verified local change",
    phase: "delivery",
    blocker: null,
    version: 5,
    updatedAt: 1,
    revision: "r1",
    criteria: [
      {
        id: "error",
        description: criterion,
        independent: false,
        evidence: [
          { kind: "ui", state: "pass", recordedAt: 1, by: { provider: "claude", model: null } },
        ],
      },
    ],
    criteriaCount: 1,
    pending: [],
    pendingCount: 0,
    steps: [],
    ...overrides,
  };
}

/** A thread whose main agent finished its turn; `child` keeps a subagent working. */
function scenario(run: OffshiftRunCard, child = false): Scenario {
  return {
    thread: { id: "thread-run", workspaceId: "acme", title: "Login error", provider: "claude" },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          facts.message("root", "ask", "user", "Show an error for a bad password."),
          ...(child
            ? [
                facts.tool("root", "spawn-check", {
                  kind: "agent.spawn",
                  title: "Check the copy",
                  detail: {
                    kind: "agent.spawn",
                    description: "Check the copy",
                    childAgent: "copy",
                  },
                }),
                facts.subagent("claude", "copy", "Check the copy", "spawn-check", {
                  background: true,
                }),
                facts.turn("copy", "spawn"),
              ]
            : []),
          facts.endTurn("root"),
        ],
      },
      { kind: "offshift", card: run },
    ],
  };
}

async function openRun(run: OffshiftRunCard, child = false) {
  const app = harness();
  app.play(scenario(run, child)).runUntilBlocked();
  await app.open("/t/thread-run");
  const work = await openWorkPanel();
  return within(work).findByRole("region", { name: "Offshift" });
}

test("a blocked run shows what blocks it", async () => {
  const section = await openRun(card({ phase: "implement", blocker: "Need a test account" }));
  expect(within(section).getByRole("status").getAttribute("aria-label")).toBe(
    "Offshift run: Waiting · Implement · 2 of 5",
  );
  expect(within(section).getByLabelText("Blocker").textContent).toBe("Need a test account");
});

test("each criterion shows once with the checks it still needs, and the outcome opens on demand", async () => {
  const section = await openRun(
    card({
      phase: "verify",
      criteria: [
        {
          id: "error",
          description: criterion,
          independent: false,
          evidence: [
            { kind: "ui", state: "stale", recordedAt: 1, by: null },
            { kind: "automated", state: "missing", recordedAt: null, by: null },
          ],
        },
      ],
      pending: [
        { criterionId: "error", kind: "ui" },
        { criterionId: "error", kind: "automated" },
      ],
      pendingCount: 2,
    }),
  );
  const criteria = within(section).getByRole("list", { name: "Criteria" });
  const [row, ...rest] = within(criteria).getAllByRole("listitem");
  expect(rest).toEqual([]);
  expect(within(row!).getByRole("img").getAttribute("aria-label")).toBe("Open");
  expect(within(row!).getByLabelText("Needs").textContent).toBe("UI · Automated");
  expect(within(section).getAllByText(criterion)).toHaveLength(1);
  expect(within(section).getByRole("status").textContent).not.toContain("Done");
  const outcome = within(section)
    .getByText("The login page shows a helpful error")
    .closest("details");
  expect(outcome?.open).toBe(false);
  await userEvent.click(within(section).getByText("Outcome"));
  expect(outcome?.open).toBe(true);
});

test("an independent criterion asks for an independent check", async () => {
  const section = await openRun(
    card({
      phase: "verify",
      criteria: [
        {
          id: "error",
          description: criterion,
          independent: true,
          evidence: [
            {
              kind: "manual",
              state: "not_independent",
              recordedAt: 1,
              by: { provider: "claude", model: null },
            },
          ],
        },
      ],
      pending: [{ criterionId: "error", kind: "manual", needs: "independent" }],
      pendingCount: 1,
    }),
  );
  const criteria = within(section).getByRole("list", { name: "Criteria" });
  expect(within(criteria).getByLabelText("Needs").textContent).toBe("Independent Manual");
  expect(within(criteria).getByRole("listitem").getAttribute("title")).toBe(
    `${criterion}\nManual check · Not independent · Claude Code`,
  );
});

test("the current phase's steps show their state, and a skipped step shows its reason", async () => {
  const section = await openRun(
    card({
      phase: "plan",
      steps: [
        { id: "reproduce", title: "Reproduce the defect", state: "done" },
        {
          id: "root-cause",
          title: "Find the root cause",
          state: "skipped",
          reason: "The stack trace names it",
        },
        { id: "bisect", title: "Bisect the history", state: "todo" },
      ],
    }),
  );
  const steps = within(section).getByRole("list", { name: "Steps" });
  expect(
    within(steps)
      .getAllByRole("listitem")
      .map((item) => [within(item).getByRole("img").getAttribute("aria-label"), item.textContent]),
  ).toEqual([
    ["Done", "Reproduce the defect"],
    ["Skipped", "Find the root causeThe stack trace names it"],
    ["To do", "Bisect the history"],
  ]);
});

test("a delivered run with every check passing is not Done while a subagent still works", async () => {
  const section = await openRun(card({}), true);
  const status = within(section).getByRole("status");
  await waitFor(() =>
    expect(status.getAttribute("aria-label")).toBe("Offshift run: Working · Delivery · 5 of 5"),
  );
  expect(status.textContent).not.toContain("Done");
});

test("a delivered run on a settled tree leaves the Summary", async () => {
  const app = harness();
  app.play(scenario(card({}))).runUntilBlocked();
  await app.open("/t/thread-run");
  const work = await openWorkPanel();
  expect(within(work).queryByRole("region", { name: "Offshift" })).toBeNull();
});

test("the Summary names the run's playbook in its status line", async () => {
  const section = await openRun(card({ phase: "verify", playbook: "perf", pendingCount: 0 }));
  expect(within(section).getByRole("status").getAttribute("aria-label")).toBe(
    "Offshift run: Waiting · Performance · Verify · 3 of 5",
  );
});
