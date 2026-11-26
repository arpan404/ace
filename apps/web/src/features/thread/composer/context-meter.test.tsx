import { contextMeter } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

const usageTitle = "124,000 of 200,000 tokens in context";

/** The readout's own text, beside whatever the strip is showing. */
async function readout() {
  const element = await screen.findByTitle(usageTitle);
  return element.textContent;
}

function unavailable(button: HTMLElement): boolean {
  return button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true";
}

test("an idle thread's card shows how much of the context is used, with a compact action", async () => {
  const app = harness();
  app.play(contextMeter()).runUntilBlocked();
  await app.open("/t/thread-context");

  expect(await readout()).toBe("62% context");
  const button = await screen.findByRole("button", { name: "Compact context" });
  expect(unavailable(button)).toBe(false);
});

test("a provider without native compaction shows the readout and no compact button", async () => {
  const app = harness();
  app.play(contextMeter({ provider: "cursor" })).runUntilBlocked();
  await app.open("/t/thread-context");

  expect(await readout()).toBe("62% context");
  expect(screen.queryByRole("button", { name: "Compact context" })).toBeNull();
});

test("pressing compact asks the provider for its own compaction", async () => {
  const app = harness();
  app.play(contextMeter()).runUntilBlocked();
  await app.open("/t/thread-context");

  fireEvent.click(await screen.findByRole("button", { name: "Compact context" }));
  // The compaction leaves the earlier occupancy unknown until the provider samples again.
  await waitFor(() => expect(screen.queryByTitle(usageTitle)).toBeNull());
  const view = app.daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse("thread-context"),
  });
  expect(
    view && "items" in view && Object.values(view.items).some((item) => item.type === "compaction"),
  ).toBe(true);
});

test("while the provider compacts, the card says so and its compact action waits", async () => {
  const scenario = contextMeter();
  scenario.steps.push({
    kind: "facts",
    facts: [
      { type: "turn.started", agent: "root", trigger: "user" },
      { type: "activity", agent: "root", activity: "compacting" },
    ],
  });
  const app = harness();
  app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-context");

  await screen.findByText("Compacting context…");
  const button = await screen.findByRole("button", { name: "Compact context" });
  expect(unavailable(button)).toBe(true);
});

test("a turn that ended with a background command still running can compact", async () => {
  const scenario = contextMeter();
  scenario.steps.push({
    kind: "facts",
    facts: [
      {
        type: "background.started",
        agent: "root",
        task: "shell",
        kind: "shell",
        title: "Dev server",
        stoppable: true,
      },
    ],
  });
  const app = harness();
  app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-context");

  const button = await screen.findByRole("button", { name: "Compact context" });
  // The model is idle though its shell still runs: the provider takes the compaction now.
  expect(unavailable(button)).toBe(false);
});
