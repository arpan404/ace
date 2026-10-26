import { facts, type Scenario } from "@ace/fake-daemon";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { componentClient } from "@/test/component-client.tsx";
import { answerStore } from "../interactions/answers.ts";
import { LostChildAction } from "./lost-child-action.tsx";

afterEach(() => answerStore.forgetAll());

/** A parent whose child on Studio was lost: the daemon's request about it is open. */
function lostScenario(threadId: string): Scenario {
  return {
    thread: { id: "parent", workspaceId: "relay", provider: "claude", title: "Parent" },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "lost",
            blocking: true,
            request: {
              kind: "approval",
              title: "Lost: Studio is no longer paired; its work there may still be running.",
              options: [
                {
                  id: "stop-tracking",
                  label: "Stop tracking; its work on Studio may still be running",
                  kind: "cancel",
                },
              ],
            },
            raw: [{ type: "ace.machine.lost", data: { machine: "studio", threadId } }],
          },
        ],
      },
    ],
  };
}

test("a lost child's row says its work may still be running, and Stop tracking answers the parent's request", async () => {
  const app = await componentClient(lostScenario("child-a"));
  app.render(<LostChildAction threadId="parent" childThreadId="child-a" />);
  expect(
    await screen.findByText(
      "Lost: Studio is no longer paired; its work there may still be running.",
    ),
  ).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Stop tracking; its work on Studio may still be running" }),
  );
  await waitFor(() =>
    expect(app.daemon.resolution("parent", "lost")).toEqual({
      kind: "approval",
      optionId: "stop-tracking",
    }),
  );
});

test("only the lost child's row offers Stop tracking", async () => {
  const app = await componentClient(lostScenario("child-a"));
  app.render(
    <>
      <LostChildAction threadId="parent" childThreadId="child-b" />
      <LostChildAction threadId="parent" childThreadId="child-a" />
    </>,
  );
  await screen.findByText("Lost: Studio is no longer paired; its work there may still be running.");
  expect(screen.getAllByRole("button", { name: /Stop tracking/ })).toHaveLength(1);
});
