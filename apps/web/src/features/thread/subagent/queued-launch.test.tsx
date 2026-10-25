import { screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

function queuedWorld(queue?: { slotLimit: number; slotsInUse: number; queuePosition: number }) {
  const app = harness({ clock: () => 10 * 60_000 });
  app.daemon.createThread({
    id: "queue-parent",
    workspaceId: "relay",
    provider: "claude",
    title: "Tidy the client",
  });
  app.daemon.createThread({
    id: "queued-child",
    workspaceId: "relay",
    provider: "claude",
    title: "Clean up",
    parentThreadId: "queue-parent",
    queuedLaunch: { text: "Remove the unused code.", ...queue },
  });
  return app;
}

test("a queued thread names its slot use and queue place", async () => {
  const app = queuedWorld({ slotLimit: 4, slotsInUse: 4, queuePosition: 2 });
  await app.open("/t/queued-child");
  const line = await screen.findByText(/run slots in use/);
  expect(line.textContent).toContain("Queued: 4 of 4 run slots in use, 2nd in line.");
  expect(line.textContent).toContain("or when you send it a message.");
});

test("a queued thread without queue facts keeps the old line", async () => {
  const app = queuedWorld();
  await app.open("/t/queued-child");
  const line = await screen.findByText(/Starts when a running agent finishes/);
  expect(line.textContent).toContain("Queued. Starts when a running agent finishes");
  expect(line.textContent).toContain("or when you send it a message.");
});
