import { facts, replayCursor } from "@ace/fake-daemon";
import type { TodoEntry } from "@ace/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

/*
 * The agents' to-do list on the composer's tab, driven by todo steps on the fake daemon: folded
 * to the step in progress, raised to the whole list, live as the agent updates it, gone once the
 * work is done, and out of the way while the agent asks something.
 */

const threadId = "thread-replay-cursor";
const todo = (content: string, status: TodoEntry["status"]): TodoEntry => ({ content, status });

/** The thread mid-turn, opened, and a way to have one of its agents write a todo list. */
async function open(storage = memoryKeyValue()) {
  const app = harness({ storage });
  app.play(replayCursor()).runThrough("finding");
  await app.open(`/t/${threadId}`);
  await screen.findByRole("combobox", { name: "Message" });
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
  return { app, plan, storage };
}

const tab = () => screen.findByRole("region", { name: "Plan" });

test("the plan folds to the step in progress, and raises to every step with its status", async () => {
  const { plan } = await open();
  plan([
    todo("Find the reset", "completed"),
    todo("Fix it", "in_progress"),
    todo("Test", "pending"),
  ]);
  const folded = await within(await tab()).findByRole("button", {
    name: "Plan, 1 of 3 done. Now: Fix it",
  });
  expect(folded.getAttribute("aria-expanded")).toBe("false");
  // The plan has the tab, so Stop goes back to the send slot.
  expect(screen.getByRole("button", { name: "Stop the agent" })).toBeTruthy();

  await userEvent.click(folded);
  const list = await within(await tab()).findByRole("list", { name: "Plan" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows).toHaveLength(3);
  expect(rows[0]?.textContent).toBe("Find the reset");
  // The step in progress carries how long it has run.
  expect(rows[1]?.textContent).toMatch(/^Fix it\d/);
  expect(rows[2]?.textContent).toBe("Test");
  expect(within(rows[0] as HTMLElement).getByRole("img", { name: "Done" })).toBeTruthy();
  expect(within(rows[1] as HTMLElement).getByRole("img", { name: "In progress" })).toBeTruthy();
  expect(rows[1]?.getAttribute("aria-current")).toBe("step");
  expect(within(rows[2] as HTMLElement).getByRole("img", { name: "To do" })).toBeTruthy();
});

test("a raised plan stays raised for that thread, and folds back with its chevron", async () => {
  const { plan, storage } = await open();
  plan([todo("Fix it", "in_progress"), todo("Test", "pending")]);
  await userEvent.click(await within(await tab()).findByRole("button", { name: /^Plan, 0 of 2/ }));
  await within(await tab()).findByRole("list", { name: "Plan" });
  cleanup();

  // Back on the thread later: still raised.
  const again = await open(storage);
  again.plan([todo("Fix it", "in_progress"), todo("Test", "pending")]);
  await within(await tab()).findByRole("list", { name: "Plan" });
  await userEvent.click(screen.getByRole("button", { name: "Fold the plan" }));
  await waitFor(() => expect(screen.queryByRole("list", { name: "Plan" })).toBeNull());
  expect(screen.getByRole("button", { name: /^Plan, 0 of 2/ })).toBeTruthy();
});

test("the plan follows the agent's updates and leaves once all is done and the turn ended", async () => {
  const { app, plan } = await open();
  plan([todo("Fix it", "in_progress"), todo("Test", "pending")]);
  await within(await tab()).findByRole("button", { name: /^Plan, 0 of 2/ });

  plan([todo("Fix it", "completed"), todo("Test", "completed")]);
  // Everything is done, but the turn still runs: the plan stays.
  expect(await screen.findByRole("button", { name: /^Plan, 2 of 2/ })).toBeTruthy();

  act(() => app.daemon.apply(threadId, [facts.endTurn("root")]));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Plan" })).toBeNull());
});

test("with several agents planning, the tab shows the main agent's list and switches to another's", async () => {
  const { app, plan } = await open();
  plan([todo("Fix it", "in_progress"), todo("Test", "pending")]);
  act(() =>
    app.daemon.apply(threadId, [
      facts.subagent("claude", "helper", "Audit", "root"),
      facts.turn("helper"),
    ]),
  );
  plan([todo("Grep the reconnect paths", "in_progress")], "helper");
  const region = await tab();
  const whose = await within(region).findByRole("button", { name: /^Whose plan: / });
  expect(within(region).getByRole("button", { name: /^Plan, 0 of 2/ })).toBeTruthy();

  await userEvent.click(whose);
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Audit" }));
  expect(
    await within(await tab()).findByRole("button", {
      name: "Plan, 0 of 1 done. Now: Grep the reconnect paths",
    }),
  ).toBeTruthy();
});

test("an agent's request takes the plan's place, and the plan comes back once it is answered", async () => {
  const { app, plan } = await open();
  plan([todo("Fix it", "in_progress"), todo("Test", "pending")]);
  await tab();
  act(() =>
    app.daemon.apply(threadId, [
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "wipe",
        blocking: true,
        request: {
          kind: "approval",
          title: "Wipe the replay cache?",
          options: [
            { id: "allow", kind: "allow_once", label: "Allow once" },
            { id: "deny", kind: "deny", label: "Deny" },
          ],
        },
      },
    ]),
  );
  const requests = await screen.findByRole("region", { name: "Waiting for you" });
  expect(screen.queryByRole("region", { name: "Plan" })).toBeNull();
  // Nothing to stop from the send slot while the agent waits on an answer.
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();

  await userEvent.click(within(requests).getByRole("button", { name: "Deny" }));
  expect(await within(await tab()).findByRole("button", { name: /^Plan, 0 of 2/ })).toBeTruthy();
});
