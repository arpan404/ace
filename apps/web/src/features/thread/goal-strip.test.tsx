import { facts, replayCursor } from "@ace/fake-daemon";
import { Capabilities, ThreadId, type ContentPart } from "@ace/protocol";
import { formatMessageQuotes } from "@ace/ui-core";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const threadId = "thread-replay-cursor";
async function open(goals: boolean) {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  // The main agent is back at its own work: nothing it only waits on outranks the goal.
  app.daemon.apply(threadId, [facts.toolDone("root", "spawn-test")]);
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

  // The whole objective fits on the row and there's no reason to read: nothing to open.
  expect(within(goal).queryByRole("button", { expanded: false })).toBeNull();
  // The controls sit on the row itself.
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

  // A quoted reply that starts with /goal keeps it; the quote shows as a count, never its block.
  const block = formatMessageQuotes([
    { id: "q1", text: "it failed on the seventh run", before: "", after: "" },
  ]);
  await queue(app, "quoted-goal", [
    { type: "text", text: `${block}\n\n` },
    { type: "text", text: "/goal make it pass" },
  ]);
  const queued = screen.getByRole("list", { name: "Queued messages" });
  expect(await within(queued).findByText("Replying to 1 quote · /goal make it pass")).toBeTruthy();
  expect(within(queued).queryByText(/replying_to/)).toBeNull();

  // A notice the daemon queues for the agent shows without its origin marker.
  await queue(app, "notice", [
    {
      type: "text",
      text: "[ace-origin:delegation.message_notice:ctl_1]\nResearcher says: the cache is cold",
    },
  ]);
  expect(await within(queued).findByText("Researcher says: the cache is cold")).toBeTruthy();
  expect(within(queued).queryByText(/ace-origin/)).toBeNull();
});

/** Queue a message on the thread as another client or the daemon would. */
async function queue(app: ReturnType<typeof harness>, id: string, input: ContentPart[]) {
  await app.client.command(
    { type: "thread.send", threadId: ThreadId.parse(threadId), input, delivery: "queue" },
    {},
    id,
  );
}
