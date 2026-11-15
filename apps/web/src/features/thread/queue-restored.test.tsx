import { facts as scenarioFacts, replayCursor } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "@/app.tsx";
import { restoreQueries } from "@/lib/query-persistence.ts";
import { harness } from "@/test/harness.tsx";
import { resetQueueEdits } from "./composer/queue-edit.ts";

/*
 * A queue page kept from an earlier session shows at once after a reload, but it is a copy the
 * daemon has not confirmed: until the daemon answers a queue read, Remove, Send again, Edit and
 * Steer (send now) do nothing. Once it answers, they work.
 */

beforeEach(() => {
  localStorage.clear();
  resetQueueEdits();
});

const threadId = "thread-replay-cursor";
const pills = () =>
  within(screen.getByRole("list", { name: "Queued messages" })).getAllByRole("listitem");

/** The daemon's queue as another device reads it: ids and words, oldest first. */
async function daemonQueue(app: ReturnType<typeof harness>) {
  const reply = await app.client.request({
    type: "queue.get",
    threadId: ThreadId.parse(threadId),
    limit: 32,
  });
  return reply.queue.messages.map((message) => ({
    id: message.id,
    text: message.input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
  }));
}

test("a queue kept from before a reload can't be acted on until the daemon answers it", async () => {
  // The earlier session: two follow-ups queued behind a running turn, the first uncertain.
  const earlierQueries = createQueryClient();
  const earlier = harness({ queryClient: earlierQueries });
  earlier.play(replayCursor()).runThrough("finding");
  earlier.daemon.apply(threadId, [scenarioFacts.toolDone("root", "spawn-test")]);
  const shown = await earlier.open(`/t/${threadId}`);
  const box = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(box, "Check the iOS path{Enter}");
  await userEvent.type(box, "Then the Android path{Enter}");
  await waitFor(async () => expect(await daemonQueue(earlier)).toHaveLength(2));
  const [uncertain] = await daemonQueue(earlier);
  if (!uncertain) throw new Error("No queued message");
  earlier.daemon.uncertainQueuedMessage(threadId, uncertain.id);
  await waitFor(() =>
    expect(within(screen.getByRole("list", { name: "Queued messages" })).getByText("Send again")),
  );
  const kept = earlierQueries
    .getQueryCache()
    .findAll({ queryKey: ["queue", threadId] })
    .filter((query) => query.state.status === "success")
    .toSorted((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0];
  if (!kept) throw new Error("No queue read");
  shown.unmount();
  const before = await daemonQueue(earlier);

  // The reload: the kept queue page is restored, and the daemon's answer to a queue read waits.
  const queries = createQueryClient();
  const revision = kept.queryKey[2];
  if (typeof revision !== "number") throw new Error("No queue revision");
  restoreQueries(queries, [
    { key: ["queue", threadId, revision], data: kept.state.data, at: kept.state.dataUpdatedAt },
  ]);
  const app = harness({ daemon: earlier.daemon, queryClient: queries });
  const answer = Promise.withResolvers<void>();
  const request = app.client.request.bind(app.client);
  vi.spyOn(app.client, "request").mockImplementation(async (message, options) => {
    if (message.type === "queue.get") await answer.promise;
    return request(message, options);
  });
  await app.open(`/t/${threadId}`);
  await waitFor(() => expect(pills()).toHaveLength(2));
  const [first, second] = pills();
  if (!first || !second) throw new Error("No pills");
  // Every action on the kept copy, clicked as a person would: none may do anything.
  fireEvent.click(within(first).getByRole("button", { name: "Send again" }));
  fireEvent.click(within(first).getByRole("button", { name: "Remove queued message" }));
  fireEvent.click(within(second).getByRole("button", { name: "Edit queued message" }));
  fireEvent.click(within(second).getByRole("button", { name: /Steer/ }));
  fireEvent.click(within(second).getByRole("button", { name: "Remove queued message" }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await daemonQueue(earlier)).toEqual(before);
  expect(screen.queryByText("Editing in composer")).toBeNull();

  // The daemon answers: the queue is confirmed, and its actions work.
  answer.resolve();
  const remove = () =>
    within(pills()[1] ?? document.body).getByRole("button", { name: "Remove queued message" });
  await waitFor(() => expect(remove().hasAttribute("disabled")).toBe(false));
  await userEvent.click(remove());
  await waitFor(async () => expect(await daemonQueue(earlier)).toHaveLength(1));
});
