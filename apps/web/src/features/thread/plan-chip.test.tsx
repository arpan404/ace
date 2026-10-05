import { ClientProvider } from "@ace/client-react";
import { facts, replayCursor } from "@ace/fake-daemon";
import type { TodoEntry } from "@ace/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { PlanChip } from "./composer/plan-chip.tsx";

/*
 * The plan chip above the composer (UX audit CMP-6), driven by the main agent's todo steps on
 * the fake daemon: it counts, lists, follows updates live and leaves once the work is done.
 */

const threadId = "thread-replay-cursor";
const todo = (content: string, status: TodoEntry["status"]): TodoEntry => ({ content, status });

/** A thread whose agent is mid-turn, and the chip that thread's composer would show. */
async function mount() {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.client.start();
  render(
    <ClientProvider client={app.client}>
      <PlanChip threadId={threadId} />
    </ClientProvider>,
  );
  const plan = (todos: TodoEntry[], agent = "root") =>
    act(() =>
      app.daemon.apply(threadId, [
        facts.tool(agent, `${agent}-plan`, {
          kind: "todo",
          title: "Update the plan",
          detail: { kind: "todo", todos },
        }),
      ]),
    );
  return { app, plan };
}

test("a todo list shows as 'Plan 1/3' and opens to every item with its status", async () => {
  const { plan } = await mount();
  expect(screen.queryByRole("button", { name: /^Plan/ })).toBeNull();
  plan([
    todo("Find the reset", "completed"),
    todo("Fix it", "in_progress"),
    todo("Test", "pending"),
  ]);

  const chip = await screen.findByRole("button", { name: "Plan 1/3: 1 of 3 done" });
  expect(chip.textContent).toBe("Plan 1/3");
  await userEvent.click(chip);
  const list = await screen.findByRole("list", { name: "Plan" });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((row) => row.textContent),
  ).toEqual(["✓Find the reset", "▸Fix it", "☐Test"]);
  expect(within(list).getByRole("img", { name: "In progress" })).toBeTruthy();
});

test("the chip follows the agent's updates and leaves once all is done and the turn ended", async () => {
  const { app, plan } = await mount();
  plan([todo("Fix it", "in_progress"), todo("Test", "pending")]);
  await screen.findByRole("button", { name: /^Plan 0\/2/ });

  plan([todo("Fix it", "completed"), todo("Test", "completed")]);
  // Everything is done, but the turn still runs: the chip stays.
  expect(await screen.findByRole("button", { name: /^Plan 2\/2/ })).toBeTruthy();

  act(() => app.daemon.apply(threadId, [facts.endTurn("root")]));
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Plan/ })).toBeNull());
});

test("a subagent's todo list doesn't take the main agent's place", async () => {
  const { app, plan } = await mount();
  plan([todo("Fix it", "in_progress"), todo("Test", "pending")]);
  await screen.findByRole("button", { name: /^Plan 0\/2/ });
  act(() =>
    app.daemon.apply(threadId, [
      facts.subagent("claude", "helper", "Audit", "root"),
      facts.turn("helper"),
    ]),
  );
  plan([todo("Grep the reconnect paths", "completed")], "helper");
  // Give the subagent's list time to land: the chip still follows the main agent.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(screen.getByRole("button", { name: /^Plan 0\/2/ })).toBeTruthy();
});
