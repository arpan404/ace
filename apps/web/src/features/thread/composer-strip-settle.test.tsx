import { longHistory } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const id = "thread-router";

/** What the composer's strip shows: its kind, or nothing. */
function stripKind(): string {
  const strip = document.querySelector("[data-composer-strip]");
  if (!strip) return "none";
  return strip.querySelector("[data-slot-kind]")?.getAttribute("data-slot-kind") ?? "?";
}

/** Every kind the strip shows from now on, in order, each once in a row. */
function watchStrip() {
  const seen = [stripKind()];
  const observer = new MutationObserver(() => {
    const kind = stripKind();
    if (seen.at(-1) !== kind) seen.push(kind);
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  return { seen, stop: () => observer.disconnect() };
}

test("a message sent before the turn starts doesn't flash the queue in the strip on its way in", async () => {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  // The daemon takes the message into its queue and starts the turn a moment later.
  app.daemon.holdQueue(id, "manual");
  await app.open(`/t/${id}`);
  await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });
  const strip = watchStrip();

  await userEvent.type(message, "continue{Enter}");
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Another device resumes the queue: the turn starts.
  const lease = app.client.thread(id);
  const revision = lease.store.queue?.revision ?? 0;
  lease.release();
  await act(() =>
    app.client.command({
      type: "thread.resume",
      threadId: ThreadId.parse(id),
      expectedRevision: revision,
    }),
  );
  // Past the hold's two-second limit, so a hold that never let go would show here too.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  strip.stop();
  // One state throughout: the strip never switched while the send settled.
  expect(strip.seen).toEqual(["none"]);
});

test("a send whose turn doesn't start lets the strip show what is current after a moment", async () => {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  app.daemon.holdQueue(id, "manual");
  await app.open(`/t/${id}`);
  await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });

  await userEvent.type(message, "continue{Enter}");
  // The queue stays paused, so the turn never runs: the strip says so once the hold is up.
  await waitFor(() => expect(stripKind()).toBe("queue"), { timeout: 4_000 });
  expect(screen.getByText("Queue paused")).toBeTruthy();
});
