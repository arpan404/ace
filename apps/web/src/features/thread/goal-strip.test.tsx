import { replayCursor } from "@ace/fake-daemon";
import { Capabilities } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const threadId = "thread-replay-cursor";
async function open(goals: boolean) {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  app.daemon.updateThread(threadId, {
    capabilities: Capabilities.parse({
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: true,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: true,
      rewindFiles: false,
      goals,
    }),
  });
  await app.open(`/t/${threadId}`);
  return app;
}
const strip = () => screen.findByRole("region", { name: "Goal" });

test("/goal sets the agent's goal, which the strip shows until it is paused and cleared", async () => {
  await open(true);
  const message = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(message, "/goal all tests in packages/api pass{Enter}");
  const goal = await strip();
  await waitFor(() => expect(goal.textContent).toContain("Pursuing goal"));
  expect(goal.textContent).toContain("all tests in packages/api pass");
  // A goal, not a message: nothing was sent to the agent as text.
  expect(within(screen.getByRole("feed", { name: "Transcript" })).queryByText(/\/goal/)).toBeNull();

  // The controls sit on the row itself: no need to open it first.
  await userEvent.click(within(goal).getByRole("button", { name: "Pause goal" }));
  await waitFor(() => expect(goal.textContent).toContain("Goal paused"));
  expect(within(goal).queryByRole("button", { name: "Pause goal" })).toBeNull();
  await userEvent.click(within(goal).getByRole("button", { name: "Resume goal" }));
  await waitFor(() => expect(goal.textContent).toContain("Pursuing goal"));
  await userEvent.click(within(goal).getByRole("button", { name: "Clear goal" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Goal" })).toBeNull());
});

test("a goal the provider keeps itself shows with its progress, and /goal goes to the agent as typed", async () => {
  const app = await open(false);
  act(() =>
    app.daemon.updateThread(threadId, {
      goal: {
        objective: "the flaky checkout test passes ten times in a row",
        status: "active",
        checks: 2,
        lastReason: "it failed on the seventh run",
      },
    }),
  );
  const goal = await strip();
  expect(goal.textContent).toContain("Pursuing goal");
  expect(goal.textContent).toContain("2 checks");
  await userEvent.click(within(goal).getByRole("button", { expanded: false }));
  expect(goal.textContent).toContain("Not met yet: it failed on the seventh run");
  // ace can't change this provider's goal: no controls offer to.
  expect(
    within(goal).queryByRole("button", { name: /Pause goal|Resume goal|Clear goal/ }),
  ).toBeNull();

  const message = screen.getByRole("combobox", { name: "Message" });
  await userEvent.type(message, "/goal ship it{Enter}");
  // The agent is mid-turn, so the message waits in the queue, as any message would.
  expect(await screen.findByText("/goal ship it")).toBeTruthy();
});
