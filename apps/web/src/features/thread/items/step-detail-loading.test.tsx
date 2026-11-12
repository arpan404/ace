import { facts, type Scenario } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";

/**
 * An opened step's detail is its own chunk. Each load of it waits here until the test lets it
 * arrive or fail, as a slow or broken network would.
 */
const loads = vi.hoisted(() => {
  const waiting: { resolve(): void; reject(error: Error): void }[] = [];
  const next = async () => {
    await vi.waitFor(() => {
      if (!waiting.length) throw new Error("No load of the step's detail is waiting");
    });
    const load = waiting.shift();
    if (!load) throw new Error("No load of the step's detail is waiting");
    return load;
  };
  return {
    begin: () => new Promise<void>((resolve, reject) => waiting.push({ resolve, reject })),
    arrive: async () => (await next()).resolve(),
    fail: async () =>
      (await next()).reject(new Error("Failed to fetch dynamically imported module")),
  };
});

// Each test starts as a fresh page: no chunk of the detail has arrived yet.
beforeEach(() => {
  vi.resetModules();
  vi.doMock("./step-detail.tsx", async (original) => {
    await loads.begin();
    return original();
  });
});

/** One finished shell step with output. */
const scenario: Scenario = {
  thread: { id: "thread-steps", workspaceId: "relay", provider: "codex", title: "Steps" },
  steps: [
    {
      kind: "facts",
      facts: [
        facts.rootAgent("codex"),
        facts.turn("root"),
        facts.tool("root", "log", {
          kind: "shell",
          title: "Read history",
          detail: { kind: "shell", command: "git log -5" },
        }),
        facts.output("root", "log", "a1b2c3 Give the restart loop a retry budget\n"),
        facts.toolDone("root", "log"),
        facts.endTurn("root"),
      ],
    },
  ],
};

async function showStep() {
  // Imported after the reset, so the client's context and the step's are the same module.
  const [{ componentClient }, { ToolStep }] = await Promise.all([
    import("@/test/component-client.tsx"),
    import("./work-log-steps.tsx"),
  ]);
  const app = await componentClient(scenario);
  const view = app.daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse(scenario.thread.id),
  });
  const itemId =
    view && "items" in view
      ? Object.values(view.items).find((item) => item.type === "tool_call")?.id
      : undefined;
  if (!itemId) throw new Error("The scenario has no step");
  app.render(
    <>
      <ul aria-label="Work log">
        <ToolStep threadId={scenario.thread.id} itemId={itemId} />
      </ul>
      <textarea aria-label="Message" />
    </>,
  );
  return within(await screen.findByRole("list", { name: "Work log" }));
}

test("a step's detail that fails to load leaves the step and composer usable, and Try again loads it", async () => {
  const log = await showStep();
  const row = await log.findByRole("button", { name: "Read git log -5" });
  await userEvent.click(row);
  await loads.fail();
  expect(await log.findByText("Couldn't show this step's detail.")).toBeTruthy();
  // The step's own row stays, and so does everything around the log.
  expect(log.getByRole("button", { name: "Read git log -5" })).toBe(row);
  const message = screen.getByRole("textbox", { name: "Message" });
  await userEvent.type(message, "Still writing");
  expect((message as HTMLTextAreaElement).value).toBe("Still writing");
  await userEvent.click(log.getByRole("button", { name: "Try again" }));
  await loads.arrive();
  expect(await log.findByText(/a1b2c3 Give the restart loop a retry budget/)).toBeTruthy();
});
