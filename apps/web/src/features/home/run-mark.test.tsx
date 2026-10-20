import { facts, type Scenario } from "@ace/fake-daemon";
import type { OffshiftRunCard } from "@ace/protocol/offshift";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

function card(overrides: Partial<OffshiftRunCard>): OffshiftRunCard {
  return {
    id: "login",
    outcome: "The login page shows a helpful error",
    outcomeTruncated: false,
    endpoint: "Verified local change",
    phase: "verify",
    blocker: null,
    version: 2,
    updatedAt: 1,
    revision: "r1",
    criteria: [],
    criteriaCount: 1,
    pending: [{ criterionId: "error", kind: "ui" }],
    pendingCount: 1,
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

async function row(run: OffshiftRunCard, child = false) {
  const app = harness();
  app.play(scenario(run, child)).runUntilBlocked();
  await app.open("/");
  const nav = await screen.findByRole("navigation", { name: "Threads" });
  return within(nav).findByRole("link", { name: /Login error/ });
}

test("a settled thread whose run stopped short names the phase and waits, never Done", async () => {
  const link = await row(card({}));
  await waitFor(() =>
    expect(within(link).getByRole("img", { name: "Run stopped at Verify" }).textContent).toBe(
      "Verify",
    ),
  );
  expect(link.getAttribute("aria-label")).toContain("Waiting · Run stopped at Verify");
  expect(within(link).queryByText("Done")).toBeNull();
});

test("a blocked run on a settled thread shows the waiting mark", async () => {
  const link = await row(card({ blocker: "Need a test account" }));
  const mark = await within(link).findByRole("img", { name: "Run blocked at Verify" });
  expect(mark.querySelector('[data-slot="status-glyph"]')?.getAttribute("data-tone")).toBe(
    "waiting",
  );
});

test("a working tree shows no run mark: it does not need the person yet", async () => {
  const link = await row(card({}), true);
  await waitFor(() => expect(link.getAttribute("aria-label")).toContain("Waiting"));
  expect(within(link).queryByRole("img", { name: /^Run / })).toBeNull();
});

test("a delivered run adds no mark", async () => {
  const link = await row(card({ phase: "delivery", pending: [], pendingCount: 0 }));
  await waitFor(() => expect(link.getAttribute("aria-label")).toContain("Done"));
  expect(within(link).queryByRole("img", { name: /^Run / })).toBeNull();
});
