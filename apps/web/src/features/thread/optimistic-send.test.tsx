import { longHistory, replayCursor } from "@ace/fake-daemon";
import { CommandId } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { resetDismissed } from "./composer/dismissed-sends.ts";
import { resetSendStore } from "./composer/send-store.ts";
import { resetStops } from "./composer/stop-state.ts";

/*
 * What the person sees between pressing Enter and the daemon having their message (UX audit
 * SY-2, SY-3, SY-7, SY-8): the bubble at once, its state under it, the same bubble once the
 * daemon has it, and nothing lost when it doesn't go.
 */

beforeEach(() => {
  localStorage.clear();
  resetSendStore();
  resetDismissed();
  resetStops();
});

async function open(scenario: "idle" | "busy", options: Parameters<typeof harness>[0] = {}) {
  const app = harness(options);
  if (scenario === "idle") app.play(longHistory(2)).runUntilBlocked();
  else app.play(replayCursor()).runThrough("finding");
  await app.open(scenario === "idle" ? "/t/thread-router" : "/t/thread-replay-cursor");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });
  return { app, feed, message: message as HTMLDivElement };
}

test("a message sent offline shows as its bubble at once and becomes the daemon's item when the connection returns", async () => {
  const { app, feed, message } = await open("idle");
  act(() => app.daemon.refuseConnections(true));
  await waitFor(() => expect(app.client.state).not.toBe("ready"));

  await userEvent.type(message, "Add a route for /settings{Enter}");
  expect(message.textContent).toBe("");
  expect(within(feed).getByText("Add a route for /settings")).toBeTruthy();
  expect(within(feed).getByText("Will apply when reconnected")).toBeTruthy();
  // The live end says since when this window has been offline.
  expect(await screen.findByText(/^Offline since \d/)).toBeTruthy();

  act(() => app.daemon.refuseConnections(false));
  // Once the daemon has it the note goes, and the message is still shown exactly once.
  await waitFor(() => expect(within(feed).queryByText("Will apply when reconnected")).toBeNull(), {
    timeout: 8_000,
  });
  expect(within(feed).getAllByText("Add a route for /settings")).toHaveLength(1);
  expect(screen.queryByText(/^Offline since/)).toBeNull();
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
});

test("a message the daemon refuses keeps its bubble with the reason, and Edit puts it back in the composer", async () => {
  const { app, feed, message } = await open("idle");
  app.daemon.refuseCommands("thread_transition_in_progress", "thread.send");

  await userEvent.type(message, "Also bump the changelog{Enter}");
  const alert = await within(feed).findByRole("alert");
  expect(within(alert).getByText("Not sent")).toBeTruthy();
  expect(
    within(alert).getByText(/The thread is switching providers; try again in a moment/),
  ).toBeTruthy();
  expect(within(feed).getByText("Also bump the changelog")).toBeTruthy();

  await userEvent.click(within(alert).getByRole("button", { name: "Edit" }));
  await waitFor(() =>
    expect((screen.getByRole("combobox", { name: "Message" }) as HTMLDivElement).textContent).toBe(
      "Also bump the changelog",
    ),
  );
  expect(within(feed).queryByText("Also bump the changelog")).toBeNull();
  expect(within(feed).queryByText("Not sent")).toBeNull();
});

test("Retry sends a refused message again and it lands once", async () => {
  const { app, feed, message } = await open("idle");
  app.daemon.refuseCommands("thread_transition_in_progress", "thread.send");
  await userEvent.type(message, "Also bump the changelog{Enter}");
  const alert = await within(feed).findByRole("alert");

  app.daemon.restoreRequests();
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(within(feed).queryByText("Not sent")).toBeNull());
  expect(within(feed).getAllByText("Also bump the changelog")).toHaveLength(1);
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
});

test("a message that may have run is never offered as Not sent with Retry", async () => {
  const { app, feed, message } = await open("idle");
  await userEvent.type(message, "Run the migration{Enter}");
  const [send] = app.client.pendingSends("thread-router").getSnapshot();
  if (!send) throw new Error("Expected the pending send");
  await waitFor(() => expect(within(feed).queryByText("Sending…")).toBeNull());

  // The provider dropped before confirming it (ADR 0065): it may have run, so a plain
  // resend could run it twice.
  act(() =>
    app.daemon.apply("thread-router", [
      {
        type: "item.upsert",
        agent: "root",
        item: "uncertain-migration",
        draft: {
          type: "notice",
          level: "error",
          commandId: CommandId.parse(send.commandId),
          code: "delivery_uncertain",
          title: "This message may have run",
          text: "This message may have run",
          complete: true,
          raw: [],
        },
      },
    ]),
  );
  expect(await within(feed).findByText(/This message may have run/)).toBeTruthy();
  expect(within(feed).queryByText("Not sent")).toBeNull();
  expect(within(feed).queryByRole("button", { name: "Retry" })).toBeNull();
  expect(within(feed).getAllByText("Run the migration")).toHaveLength(1);
});

test("a message too large for the daemon says how large it is against the limit", async () => {
  const first = await open("idle");
  first.app.daemon.refuseCommands("message_too_large", "thread.send");
  await userEvent.type(first.message, "A very long paste{Enter}");
  expect(await within(first.feed).findByText(/Too long: 1 KB, the limit is 256 KB/)).toBeTruthy();
});

test("a queued follow-up is a pill the moment Enter is pressed, and never also a bubble", async () => {
  const { app, feed, message } = await open("busy");
  // The queue read is slow; the pill doesn't wait for it.
  app.daemon.holdRequests("queue.get");
  await userEvent.type(message, "Also check the iOS cold-start path{Enter}");
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  expect(within(queue).getByText("Also check the iOS cold-start path")).toBeTruthy();
  expect(within(feed).queryByText("Also check the iOS cold-start path")).toBeNull();
});

test("removing a queued message takes its pill away at once", async () => {
  const { feed, message } = await open("busy");
  await userEvent.type(message, "Also check the iOS cold-start path{Enter}");
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  await waitFor(() =>
    expect(within(queue).queryByRole("button", { name: "Remove from queue" })).toBeTruthy(),
  );
  await userEvent.click(within(queue).getByRole("button", { name: "Remove from queue" }));
  await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
  expect(within(feed).queryByText("Also check the iOS cold-start path")).toBeNull();
});

test("a removal the daemon refuses keeps the message, which shows once it is delivered", async () => {
  const { app, feed, message } = await open("busy");
  await userEvent.type(message, "Also check the iOS cold-start path{Enter}");
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  await waitFor(() =>
    expect(within(queue).queryByRole("button", { name: "Remove from queue" })).toBeTruthy(),
  );
  app.daemon.refuseCommands("queue_conflict", "queue.remove");
  await userEvent.click(within(queue).getByRole("button", { name: "Remove from queue" }));
  expect(await screen.findByText("Couldn't remove the message")).toBeTruthy();
  app.daemon.restoreRequests();
  expect(
    within(await screen.findByRole("list", { name: "Queued messages" })).getByText(
      "Also check the iOS cold-start path",
    ),
  ).toBeTruthy();

  // Once the agent is free the daemon delivers it, and its bubble shows.
  await userEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull());
  act(() =>
    app.daemon.apply("thread-replay-cursor", [
      { type: "background.ended", task: "relay", status: "stopped" },
    ]),
  );
  expect(await within(feed).findByText("Also check the iOS cold-start path")).toBeTruthy();
});

test("Stop reads Stopping… on the button and the live line until the turn ends", async () => {
  const { app } = await open("busy");
  act(() => app.daemon.refuseConnections(true));
  await waitFor(() => expect(app.client.state).not.toBe("ready"));

  await userEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
  expect(screen.getByRole("button", { name: "Stopping…" })).toBeTruthy();
  expect(screen.getByRole("status", { name: "Stopping…" })).toBeTruthy();

  act(() => app.daemon.refuseConnections(false));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stopping…" })).toBeNull(), {
    timeout: 8_000,
  });
  expect(screen.queryByRole("status", { name: "Stopping…" })).toBeNull();
});

test("typing on the page writes into the composer", async () => {
  const { message } = await open("idle");
  message.blur();
  // Focus is on the page (or the title it moves to on navigation), not in a field.
  expect(document.activeElement?.closest("textarea, input")).toBeNull();
  await userEvent.keyboard("hello");
  expect(document.activeElement).toBe(message);
  expect(message.textContent).toBe("hello");
});

test("a draft written in another window replaces an idle composer's, and is offered to a focused one", async () => {
  const { app, message } = await open("idle");
  const other = (text: string) => {
    app.storage.setItem(
      "ace.composer.drafts",
      JSON.stringify([["thread:thread-router", { text, mentions: [], attachments: [] }]]),
    );
    act(() => {
      dispatchEvent(new StorageEvent("storage", { key: "ace.composer.drafts" }));
    });
  };
  message.blur();
  other("Written on the laptop");
  expect(message.textContent).toBe("Written on the laptop");

  await userEvent.click(message);
  await userEvent.type(message, " and here");
  other("Changed again elsewhere");
  expect(message.textContent).toBe("Written on the laptop and here");
  await userEvent.click(screen.getByRole("button", { name: "Use that version" }));
  expect(message.textContent).toBe("Changed again elsewhere");
});

test("a draft with a file written in another window brings the file, and sends it", async () => {
  const { app, message } = await open("idle");
  const sent: unknown[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command) => {
    if (command.payload.type === "thread.send") sent.push(command.payload.context);
    return receive(command);
  };
  const sha256 = "a".repeat(64);
  message.blur();
  app.storage.setItem(
    "ace.composer.drafts",
    JSON.stringify([
      [
        "thread:thread-router",
        { text: "Look at this", mentions: [], attachments: [{ sha256, name: "shot.png" }] },
      ],
    ]),
  );
  act(() => {
    dispatchEvent(new StorageEvent("storage", { key: "ace.composer.drafts" }));
  });
  const chips = await screen.findByRole("list", { name: "Attachments" });
  expect(within(chips).getByText("shot.png")).toBeTruthy();
  const composer = screen.getByRole("combobox", { name: "Message" }) as HTMLDivElement;
  expect(composer.textContent).toBe("Look at this");
  // This window doesn't write its own (older) copy back over the other window's, even when the
  // page hides and every pending draft is written at once.
  act(() => {
    dispatchEvent(new Event("pagehide"));
  });
  expect(app.storage.getItem("ace.composer.drafts")).toContain(sha256);

  await userEvent.type(composer, "{Enter}");
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({ attachments: [{ sha256 }] });
});
