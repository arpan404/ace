import { facts, type Scenario } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import { act, configure, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());

const id = "thread-bookkeeping";
const title = "Background bookkeeping";

/** A turn that leaves `left` running, then ends; the thread's row beside it. */
async function turnEndedLeaving(left: readonly Fact[]) {
  const app = harness();
  const scenario: Scenario = {
    thread: { id, title, workspaceId: "ace", provider: "claude" },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          facts.message("root", "ask", "user", "Fix the lease in the background."),
          ...left,
        ],
      },
    ],
  };
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${id}`);
  act(() => app.daemon.apply(id, [facts.endTurn("root")]));
  const row = await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole(
    "link",
    { name: new RegExp(`^${title}`) },
  );
  return { app, row };
}

/** A subagent's work the provider hasn't registered as an agent yet, as Claude's adapter keeps it. */
const standIn: Fact = {
  type: "background.started",
  agent: "root",
  task: "claude:s:p1:unbound:toolu_1",
  kind: "subagent",
  title: "Claude child awaiting task registration",
  stoppable: false,
};
const bookkeeping: Fact = {
  type: "background.started",
  agent: "root",
  task: "claude:s:p1:unbound:overflow",
  kind: "other",
  title: "Claude child transcript recovery exceeded its limit",
  internal: true,
  stoppable: false,
};
const devServer: Fact[] = [
  facts.tool("root", "dev", {
    kind: "shell",
    title: "Start the dev server",
    detail: { kind: "shell", command: "bun run dev" },
  }),
  {
    type: "background.started",
    agent: "root",
    task: "dev",
    kind: "shell",
    title: "Start the dev server",
    item: "dev",
    stoppable: true,
  },
];

const strip = () => document.querySelector("[data-composer-strip]");

test("a thread whose only open work stands for a subagent waits on 1 subagent, its task title never shown", async () => {
  const { row } = await turnEndedLeaving([standIn]);
  const waiting = await screen.findByRole("status", { name: /^Waiting for 1 subagent/ });
  expect(within(waiting).queryByText(/command/)).toBeNull();
  expect(strip()?.querySelector("code")).toBeNull();
  expect(screen.queryByText(/awaiting task registration/)).toBeNull();
  expect(row.getAttribute("aria-label") ?? "").not.toMatch(/awaiting task registration/);
  expect(within(row).queryByText("Done", { exact: true })).toBeNull();
  expect(row.getAttribute("aria-label") ?? "").not.toMatch(/\. Done/);
});

test("ace's own bookkeeping holds the thread open but no surface lists or names it", async () => {
  const { row } = await turnEndedLeaving([bookkeeping]);
  // Something still holds the thread: never Done, yet nothing is counted or named.
  expect(await within(row).findByText("Background", { exact: true })).toBeTruthy();
  expect(within(row).queryByText("Done", { exact: true })).toBeNull();
  expect(screen.queryByRole("status", { name: /^Running \d|^Waiting for/ })).toBeNull();
  expect(screen.queryByText(/exceeded its limit/)).toBeNull();
  expect(row.getAttribute("aria-label") ?? "").not.toMatch(/exceeded its limit|\. Done/);
  expect(screen.queryByRole("button", { name: /^Worked for/ })).toBeNull();
});

test("the strip names a single background shell by its command, as code", async () => {
  await turnEndedLeaving(devServer);
  const running = await screen.findByRole("status", { name: "Running bun run dev" });
  expect(running.querySelector("code")?.textContent).toBe("bun run dev");
  expect(within(running).getByRole("button", { name: "Stop the background command" })).toBeTruthy();
});

test("a subagent stand-in beside a shell reads as a subagent, the command counted after it", async () => {
  await turnEndedLeaving([...devServer, standIn, bookkeeping]);
  const waiting = await screen.findByRole("status", {
    name: /^Waiting for 1 subagent · 1 command running/,
  });
  expect(waiting.querySelector("code")).toBeNull();
  expect(screen.queryByText(/awaiting task registration|exceeded its limit/)).toBeNull();
});
