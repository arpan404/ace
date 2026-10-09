import { seedRealThreadState } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("a joined legacy handoff echo shows only the person's text", async () => {
  const app = harness();
  seedRealThreadState(app.daemon);
  await app.open("/t/legacy-handoff");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByText("hi")).toBeTruthy();
  expect(feed.textContent).not.toContain("sourceThreadId");
  expect(feed.textContent).not.toContain('"version"');
});

test("Retry releases the retained original message and shows no duplicate user bubble", async () => {
  const app = harness();
  seedRealThreadState(app.daemon);
  app.daemon.holdRequests("queue.get");
  await app.open("/t/legacy-send");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const retry = await within(feed).findByRole("button", { name: "Retry" });
  act(() => app.daemon.restoreRequests());
  await userEvent.click(retry);
  await waitFor(() => expect(within(feed).queryByText("Not sent")).toBeNull());
  expect(within(feed).getAllByText("Please continue from this message")).toHaveLength(1);
  const { queue } = await app.client.request({
    type: "queue.get",
    threadId: ThreadId.parse("legacy-send"),
  });
  expect(queue.messages).toEqual([]);
});

test("a manual queue pause with no queued messages adds no recovery prompt", async () => {
  const app = harness();
  seedRealThreadState(app.daemon);
  app.daemon.holdQueue("legacy-notices", "manual");
  await app.open("/t/legacy-notices");
  await screen.findByRole("feed", { name: "Transcript" });
  expect(screen.queryByText("Queue paused")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Resume$/ })).toBeNull();
});
