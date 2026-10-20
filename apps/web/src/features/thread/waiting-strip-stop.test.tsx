import { facts, type Scenario } from "@ace/fake-daemon";
import type { CommandPayload } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const id = "thread-waiting-stop";

type Started = {
  task: string;
  kind: "shell" | "monitor" | "other";
  title: string;
  stoppable: boolean;
};

/** A turn that starts `tasks` in the background, then ends while they still run. */
async function finishedTurnWaitingOn(tasks: readonly Started[]) {
  const app = harness();
  const scenario: Scenario = {
    thread: { id, title: "Background work", workspaceId: "ace", provider: "claude" },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          facts.message("root", "ask", "user", "Start the dev server and watch CI."),
          ...tasks.flatMap((task) => [
            facts.tool("root", task.task, {
              kind: "shell",
              title: task.title,
              detail: { kind: "shell", command: task.title },
            }),
            {
              type: "background.started" as const,
              agent: "root",
              task: task.task,
              kind: task.kind,
              title: task.title,
              item: task.task,
              stoppable: task.stoppable,
            },
          ]),
        ],
      },
    ],
  };
  app.play(scenario).runUntilBlocked();
  const sent: CommandPayload[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command) => {
    sent.push(command.payload);
    return receive(command);
  };
  await app.open(`/t/${id}`);
  act(() => app.daemon.apply(id, [facts.endTurn("root")]));
  const stops = () => sent.filter((payload) => payload.type === "background_task.stop");
  return { app, stops };
}

test("Stop in the waiting strip ends every background command it can, whatever its kind", async () => {
  const { stops } = await finishedTurnWaitingOn([
    { task: "dev", kind: "shell", title: "bun run dev", stoppable: true },
    { task: "ci", kind: "monitor", title: "gh run watch", stoppable: true },
    { task: "sync", kind: "other", title: "provider sync", stoppable: false },
  ]);
  const strip = await screen.findByRole("status", { name: "Waiting for 3 background commands" });
  await userEvent.click(
    within(strip).getByRole("button", { name: "Stop the background commands" }),
  );

  await waitFor(() => expect(stops()).toHaveLength(2));
  // What can't be stopped keeps running, and the strip now waits on it alone, with no Stop.
  const left = await screen.findByRole("status", { name: "Waiting for provider sync" });
  expect(within(left).queryByRole("button", { name: /^Stop/ })).toBeNull();
});

test("a turn waiting on one stoppable monitor offers Stop, and pressing it ends the wait", async () => {
  const { stops } = await finishedTurnWaitingOn([
    { task: "ci", kind: "monitor", title: "gh run watch", stoppable: true },
  ]);
  const strip = await screen.findByRole("status", { name: "Waiting for gh run watch" });
  await userEvent.click(within(strip).getByRole("button", { name: "Stop the background command" }));

  await waitFor(() => expect(stops()).toHaveLength(1));
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "Waiting for gh run watch" })).toBeNull(),
  );
});

test("the waiting strip shows no Stop when none of its background commands can be stopped", async () => {
  const { stops } = await finishedTurnWaitingOn([
    { task: "a", kind: "other", title: "provider sync", stoppable: false },
    { task: "b", kind: "shell", title: "bun run dev", stoppable: false },
  ]);
  const strip = await screen.findByRole("status", { name: "Waiting for 2 background commands" });
  expect(within(strip).queryByRole("button", { name: /^Stop/ })).toBeNull();
  expect(stops()).toEqual([]);
});
