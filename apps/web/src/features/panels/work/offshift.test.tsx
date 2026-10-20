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
        evidence: [{ kind: "ui", state: "pass", recordedAt: 1 }],
      },
    ],
    criteriaCount: 1,
    pending: [],
    pendingCount: 0,
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

test("a run that lacks evidence lists each missing check, and its criteria open on demand", async () => {
  const section = await openRun(
    card({
      phase: "verify",
      criteria: [
        {
          id: "error",
          description: criterion,
          evidence: [{ kind: "ui", state: "stale", recordedAt: 1 }],
        },
      ],
      pending: [{ criterionId: "error", kind: "ui" }],
      pendingCount: 1,
    }),
  );
  const missing = within(section).getByRole("list", { name: "Missing evidence" });
  expect(within(missing).getByRole("listitem").textContent).toBe(`${criterion}UI check`);
  expect(within(section).getByRole("status").textContent).not.toContain("Done");
  await userEvent.click(within(section).getByText("Outcome and criteria"));
  const criteria = within(section).getByRole("list", { name: "Criteria" });
  expect(criteria.textContent).toContain("UI check Out of date");
  expect(within(section).getByText("The login page shows a helpful error")).toBeTruthy();
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
