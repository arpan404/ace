import { facts, type Scenario } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { componentClient } from "@/test/component-client.tsx";
import { ToolStep } from "./work-log-steps.tsx";

/** One finished browser step whose provider payloads only its Raw view shows. */
const scenario: Scenario = {
  thread: { id: "thread-raw", workspaceId: "relay", provider: "claude", title: "Raw" },
  steps: [
    {
      kind: "facts",
      facts: [
        facts.rootAgent("claude"),
        facts.turn("root"),
        {
          type: "item.upsert",
          agent: "root",
          item: "page",
          draft: {
            type: "tool_call",
            complete: true,
            call: {
              status: "succeeded",
              kind: "browser",
              title: "Opened the pricing page",
              detail: { kind: "browser" },
              raw: [{ type: "browser_frame", data: { marker: "frame-from-the-provider" } }],
            },
          },
        },
        facts.endTurn("root"),
      ],
    },
  ],
};

test("a step's raw payloads left out of the transcript load when its Raw view opens", async () => {
  const app = await componentClient(scenario);
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-raw") });
  const itemId =
    view && "items" in view
      ? Object.values(view.items).find((item) => item.type === "tool_call")?.id
      : undefined;
  if (!itemId) throw new Error("The scenario has no step");
  app.render(
    <ul aria-label="Work log">
      <ToolStep threadId="thread-raw" itemId={itemId} />
    </ul>,
  );
  const log = within(await screen.findByRole("list", { name: "Work log" }));
  await userEvent.click(await log.findByRole("button", { name: /pricing page/ }));
  // The transcript arrived without the payloads: nothing of them shows until asked for.
  expect(log.queryByText(/frame-from-the-provider/)).toBeNull();
  await userEvent.click(await log.findByRole("button", { name: "Raw" }));
  expect(await log.findByText(/frame-from-the-provider/)).toBeTruthy();
});
