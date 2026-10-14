import type { Fact } from "@ace/core";
import { facts, sessionLimitText } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const spawn = (child: string, name: string, task: string): Fact[] => [
  facts.tool("root", `spawn-${child}`, {
    kind: "agent.spawn",
    title: task,
    detail: { kind: "agent.spawn", description: task, childAgent: child },
  }),
  facts.subagent("claude", child, name, `spawn-${child}`),
  facts.turn(child, "spawn"),
];

/** Opens the transcript's subagent card and follows the named subagent's row. */
async function openSubagent(card: string, name: string) {
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const region = await within(feed).findByRole("region", { name: card });
  const disclosure = within(region).queryByRole("button", { name: card });
  if (disclosure) await userEvent.click(disclosure);
  await userEvent.click(within(region).getByRole("link", { name: new RegExp(`^Open ${name},`) }));
  await screen.findByRole("heading", { level: 1, name });
  return screen.getByRole("group", { name: "Subagent" });
}

test("a subagent stopped by its session limit shows the limit and its reset quietly, and Ask parent to retry queues a message naming it while the parent works", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "triage",
    workspaceId: "relay",
    provider: "claude",
    title: "Triage issues",
  });
  app.daemon.apply("triage", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    ...spawn("layout", "layout-fixer", "Apply the layout fixes"),
    facts.endTurn("layout", "failed", { kind: "provider", message: sessionLimitText }),
    facts.toolDone("root", "spawn-layout", "failed"),
  ]);
  await app.open("/t/triage");
  const bar = await openSubagent("1 subagent", "layout-fixer");

  // The failure is in the body, named as a limit with when it lifts, not "Turn failed".
  const row = await screen.findByRole("group", { name: /^Usage limit reached/ });
  expect(within(row).getByText(/Resets 8:30pm \(America\/Chicago\)/)).toBeTruthy();
  expect(screen.queryByText("Turn failed")).toBeNull();

  // Nothing runs, so nothing to stop; only its parent can run it again.
  expect(within(bar).queryByRole("button", { name: /^Stop/ })).toBeNull();
  await userEvent.click(within(bar).getByRole("button", { name: "Ask parent to retry" }));
  expect(await within(bar).findByText("Queued for parent")).toBeTruthy();

  // The parent still works: the request waits in its queue, naming the subagent and why.
  await userEvent.click(within(bar).getByRole("link", { name: "Open parent" }));
  await screen.findByRole("heading", { level: 1, name: "Triage issues" });
  expect(
    await screen.findByText(
      /The subagent “layout-fixer” \(Apply the layout fixes\) failed: You've hit your session limit/,
    ),
  ).toBeTruthy();
});

test("a subagent gone silent never reads as working: Not responding with Stop, and once stopped its idle parent is asked only on the press", async () => {
  let now = 1_000;
  const app = harness({ clock: () => now, uiClock: () => now });
  app.daemon.createThread({
    id: "audit",
    workspaceId: "relay",
    provider: "claude",
    title: "Audit dependencies",
    silenceMs: 60_000,
  });
  app.daemon.apply("audit", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    ...spawn("deps", "dep-auditor", "Audit outdated dependencies"),
    facts.toolDone("root", "spawn-deps"),
    facts.endTurn("root"),
  ]);
  await app.open("/t/audit");
  const bar = await openSubagent("1 subagent", "dep-auditor");
  expect(within(bar).getByText(/^Working for/)).toBeTruthy();

  // Its turn stays open but nothing has come from it for longer than the daemon allows.
  now += 120_000;
  act(() => app.daemon.apply("audit", [{ type: "tick" }]));
  expect(await within(bar).findByText("Not responding")).toBeTruthy();
  expect(within(bar).queryByText(/^Working for/)).toBeNull();
  expect(screen.queryByRole("status", { name: /^Working/ })).toBeNull();
  // Not ended either: no retry until it is stopped.
  expect(within(bar).queryByRole("button", { name: "Ask parent to retry" })).toBeNull();

  await userEvent.click(within(bar).getByRole("button", { name: /^Stop dep-auditor/ }));
  expect(await within(bar).findByText(/^Stopped/)).toBeTruthy();
  // The parent's turn had ended: nothing reached it on its own.
  await userEvent.click(within(bar).getByRole("button", { name: "Ask parent to retry" }));
  expect(await within(bar).findByText("Sent to parent")).toBeTruthy();

  await userEvent.click(within(bar).getByRole("link", { name: "Open parent" }));
  await screen.findByRole("heading", { level: 1, name: "Audit dependencies" });
  expect(
    await screen.findByText(
      /The subagent “dep-auditor” \(Audit outdated dependencies\) was stopped before it finished\./,
    ),
  ).toBeTruthy();
});
