import { ClientProvider } from "@ace/client-react";
import { FakeDaemon, ScenarioPlayer, facts } from "@ace/fake-daemon";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { fakeClient } from "@/test/fake-client.ts";
import { AssistantMessage } from "./messages.tsx";
import { WorkLogHeader, WorkLogLine } from "./work-log-view.tsx";

test("Worked-for header and line show only the label, never a time", () => {
  const header = render(
    <WorkLogHeader label="Worked for 47s" open={false} panel="panel" onToggle={() => {}} />,
  );
  expect(header.getByText("Worked for 47s")).toBeTruthy();
  expect(header.container.querySelector("time")).toBeNull();
  header.unmount();
  const line = render(<WorkLogLine label="Worked for 47s" />);
  expect(line.getByText("Worked for 47s")).toBeTruthy();
  expect(line.container.querySelector("time")).toBeNull();
  line.unmount();
});

function answerScenario(threadId: string) {
  const daemon = new FakeDaemon({ clock: () => 1_700_000_000_000 });
  new ScenarioPlayer(daemon, {
    thread: { id: threadId, workspaceId: "project", provider: "codex", title: "Turn time" },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("codex"),
          facts.turn("root"),
          {
            type: "item.upsert",
            agent: "root",
            item: "answer",
            draft: {
              type: "message",
              role: "assistant",
              complete: true,
              parts: [{ type: "text", text: "Done." }],
            },
          },
          facts.endTurn("root"),
        ],
      },
    ],
  }).runUntilBlocked();
  return daemon;
}

async function renderAnswer(threadId: string) {
  const daemon = answerScenario(threadId);
  const client = fakeClient(daemon);
  await client.start();
  const lease = client.thread(threadId);
  await waitFor(() => expect(lease.store.order.length).toBe(1));
  const itemId = lease.store.order[0];
  if (!itemId) throw new Error("Missing answer");
  const view = render(
    <ClientProvider client={client}>
      <TooltipProvider>
        <AssistantMessage threadId={threadId} itemId={itemId} />
      </TooltipProvider>
    </ClientProvider>,
  );
  await screen.findByText("Done.");
  return { view, lease };
}

test("a finished answer keeps its time in the actions row, laid over the room below it", async () => {
  const { view, lease } = await renderAnswer("turn-time-actions");
  const time = view.container.querySelector("time");
  expect(time).not.toBeNull();
  const actions = time?.closest("div.opacity-0");
  // Same visibility as Copy and Fork: on hover or focus, always on touch.
  expect(actions).not.toBeNull();
  expect(actions?.className).toContain("pointer-coarse:opacity-100");
  expect(actions?.className).toContain("group-focus-within/answer:opacity-100");
  // Out of the answer's flow: it costs the answer no height when it finishes.
  expect(actions?.className).toContain("absolute");
  view.unmount();
  lease.release();
});
