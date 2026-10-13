import { facts } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
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

// Mutation: offering a disclosure with nothing behind it.
test("a finished turn with nothing but its answer reads Worked for as plain text, with nothing to open", async () => {
  const { feed } = await finished(false);
  expect(await within(feed).findByText(/^Worked for/)).toBeTruthy();
  await waitFor(() =>
    expect(within(feed).queryByRole("button", { name: /^Worked for/ })).toBeNull(),
  );
  expect(within(feed).queryByText("No steps recorded.")).toBeNull();
  // The answer stays in view, outside the log.
  expect(await within(feed).findAllByText("The build passes.")).toHaveLength(1);
});

test("a finished turn with steps still opens on them", async () => {
  const { feed } = await finished(true);
  await userEvent.click(await within(feed).findByRole("button", { name: /^Worked for/ }));
  expect(await within(feed).findByText(/bun run build/)).toBeTruthy();
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

// Mutation: stopping a long turn's log at its first read with no way to read on.
test("a turn longer than one read offers to load the rest of its steps", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "long",
    workspaceId: "ace",
    title: "Long turn",
    provider: "claude",
  });
  app.daemon.apply("long", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Run every step"),
    ...Array.from({ length: 1001 }, (_, index) => ({
      type: "item.upsert" as const,
      agent: "root",
      item: `step-${index}`,
      draft: {
        type: "tool_call" as const,
        complete: true,
        call: {
          status: "succeeded" as const,
          kind: "shell" as const,
          title: "step",
          detail: { kind: "shell" as const, command: `bun run step-${index}` },
          raw: [],
        },
      },
    })),
    facts.message("root", "answer", "assistant", "Every step ran."),
    facts.endTurn("root"),
  ]);
  await app.open("/t/long");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(await within(feed).findByRole("button", { name: /^Worked for/ }));
  expect(await within(feed).findByText("Ran 1000 commands", {}, { timeout: 8000 })).toBeTruthy();
  await userEvent.click(within(feed).getByRole("button", { name: "Load more steps" }));
  expect(await within(feed).findByText("Ran 1001 commands", {}, { timeout: 8000 })).toBeTruthy();
  expect(within(feed).queryByRole("button", { name: "Load more steps" })).toBeNull();
}, 30_000);
