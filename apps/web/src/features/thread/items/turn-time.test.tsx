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

async function renderAnswer(threadId: string, headed: boolean | undefined) {
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
        <AssistantMessage threadId={threadId} itemId={itemId} headed={headed} />
      </TooltipProvider>
    </ClientProvider>,
  );
  await screen.findByText("Done.");
  return { view, lease };
}

test("a headed answer keeps its time inside the hover-only actions row", async () => {
  const { view, lease } = await renderAnswer("turn-time-headed", true);
  const time = view.container.querySelector("time");
  expect(time).not.toBeNull();
  // Same hover-only visibility as copy/fork: hidden until the answer is hovered.
  expect(time?.closest("div.opacity-0")).not.toBeNull();
  view.unmount();
  lease.release();
});

test("a non-headed answer keeps its time always visible", async () => {
  const { view, lease } = await renderAnswer("turn-time-plain", undefined);
  const time = view.container.querySelector("time");
  expect(time).not.toBeNull();
  expect(time?.closest("div.opacity-0")).toBeNull();
  view.unmount();
  lease.release();
});
