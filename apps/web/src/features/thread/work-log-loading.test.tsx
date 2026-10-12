import { facts } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { preloadStepLabels } from "./items/step-labels.ts";

/*
 * A finished turn's "Worked for" log reads its steps from the daemon (`turn.steps`) as it opens:
 * a read that finds nothing says so, and one that fails says so with Retry, never a skeleton
 * that stays forever or a silent partial list.
 */

beforeEach(async () => {
  localStorage.clear();
  await preloadStepLabels();
});

async function finished(withSteps: boolean) {
  const app = harness();
  app.daemon.createThread({ id: "log", workspaceId: "ace", title: "Work log", provider: "claude" });
  app.daemon.apply("log", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Check the build"),
    ...(withSteps
      ? [
          facts.tool("root", "build", {
            kind: "shell",
            title: "bun run build",
            detail: { kind: "shell", command: "bun run build" },
          }),
          facts.toolDone("root", "build"),
        ]
      : []),
    facts.message("root", "answer", "assistant", "The build passes."),
    facts.endTurn("root"),
  ]);
  await app.open("/t/log");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  return { app, feed };
}

// Mutation: treating a read with no steps as no read (a skeleton forever).
test("a finished turn with nothing but its answer opens to say it recorded no steps", async () => {
  const { feed } = await finished(false);
  await userEvent.click(await within(feed).findByRole("button", { name: /^Worked for/ }));
  expect(await within(feed).findByText("No steps recorded.")).toBeTruthy();
  expect(within(feed).queryByRole("status", { name: "Loading steps" })).toBeNull();
  // The answer stays in view, outside the log.
  expect(within(feed).getAllByText("The build passes.")).toHaveLength(1);
});

// Mutation: silently showing whatever the window holds after a failed read.
test("a failed read says so with Retry, and Retry reads the steps", async () => {
  const { app, feed } = await finished(true);
  app.daemon.failRequests("turn.steps");
  await userEvent.click(await within(feed).findByRole("button", { name: /^Worked for/ }));
  const alert = await within(feed).findByRole("alert");
  expect(alert.textContent).toContain("Couldn't load these steps.");
  expect(within(feed).queryByRole("button", { name: /^Ran bun run build/ })).toBeNull();
  app.daemon.restoreRequests();
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  expect(await within(feed).findByRole("button", { name: /^Ran bun run build/ })).toBeTruthy();
  expect(within(feed).queryByRole("alert")).toBeNull();
});
