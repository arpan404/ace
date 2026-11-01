import { facts } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import type { MessageOrigin, Thread } from "@ace/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * A message another thread's agent sent this one (a delegated task, a follow-up, work from a
 * paired machine) reads as a sent message under one line naming who sent it, which opens them.
 */

beforeEach(() => localStorage.clear());

const said = (item: string, text: string, origin?: MessageOrigin): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: {
    type: "message",
    role: "user",
    complete: true,
    parts: [{ type: "text", text }],
    ...(origin ? { origin } : {}),
  },
});

function seed(
  child: { parentThreadId?: string; delegatedFrom?: Thread["delegatedFrom"] },
  messages: Fact[],
) {
  const app = harness();
  app.daemon.createThread({
    id: "thread-parent",
    workspaceId: "shop",
    title: "Checkout rewrite",
    provider: "claude",
  });
  app.daemon.apply("thread-parent", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "parent-ask", "user", "Split the checkout work up."),
    facts.endTurn("root"),
  ]);
  app.daemon.createThread({
    id: "thread-child",
    workspaceId: "shop",
    title: "Payment tests",
    provider: "codex",
    hasSentMessage: true,
    ...child,
  });
  app.daemon.apply("thread-child", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    ...messages,
    facts.message("root", "reply", "assistant", "On it."),
    facts.endTurn("root"),
  ]);
  return app;
}

async function transcript() {
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("On it.");
  return feed;
}

const fromParent = { parentThreadId: "thread-parent", from: { provider: "claude" } } as const;

test("a delegate's task and a later follow-up are sent by the parent's agent, and open the parent", async () => {
  const app = seed({ parentThreadId: "thread-parent" }, [
    said("task", "Role: payments\n\nTask:\nCover refunds with tests.", {
      kind: "spawn",
      role: "payments",
      ...fromParent,
    }),
    said("steer", "Also cover partial refunds.", { kind: "parent_agent", ...fromParent }),
  ]);
  await app.open("/t/thread-child");
  const feed = await transcript();
  // The task's words, without ace's role frame, and the follow-up, each under its own line.
  expect(within(feed).getByText("Cover refunds with tests.")).toBeTruthy();
  expect(within(feed).queryByText(/Role: payments/)).toBeNull();
  expect(within(feed).getByText("Also cover partial refunds.")).toBeTruthy();
  expect(within(feed).getAllByRole("link", { name: "Sent by Checkout rewrite" })).toHaveLength(2);
  // Renamed later, the parent is named by its new title.
  await app.client.command({
    type: "thread.rename",
    threadId: "thread-parent",
    title: "Checkout v2",
  });
  const lines = await within(feed).findAllByRole("link", { name: "Sent by Checkout v2" });
  expect(lines).toHaveLength(2);
  await userEvent.click(lines[1]!);
  expect(
    await within(await screen.findByRole("feed", { name: "Transcript" })).findByText(
      "Split the checkout work up.",
    ),
  ).toBeTruthy();
});

test("a child an agent on a paired machine delegated names that machine, and links nowhere while it is out of reach", async () => {
  const app = seed(
    {
      delegatedFrom: {
        hostId: "host-laptop",
        hostName: "Arpan's MacBook Pro",
        threadId: "thread-remote-parent",
        threadTitle: "Redesign Sidebar for Easier Navigation",
        provider: "claude",
      },
    },
    [said("task", "Run the iOS suite.", { kind: "spawn", role: "ios" })],
  );
  await app.open("/t/thread-child");
  const feed = await transcript();
  const line = within(feed).getByText(
    "Sent by Redesign Sidebar for Easier Navigation · Arpan's MacBook Pro",
  );
  expect(line.closest("a")).toBeNull();
  expect(within(feed).getByText("Run the iOS suite.")).toBeTruthy();
});

test("a message ace can't trace to a sender still shows in full, sent from another thread", async () => {
  const app = seed({}, [said("task", "Check the logs.", { kind: "parent_agent" })]);
  await app.open("/t/thread-child");
  const feed = await transcript();
  const line = within(feed).getByText("Sent from another thread");
  expect(line.closest("a")).toBeNull();
  expect(within(feed).getByText("Check the logs.")).toBeTruthy();
});

test("the person's own messages carry no sender line", async () => {
  const app = seed({ parentThreadId: "thread-parent" }, [
    said("ask", "Please also check the webhook."),
    said("steered", "And the receipts.", { kind: "steer" }),
  ]);
  await app.open("/t/thread-child");
  const feed = await transcript();
  expect(within(feed).getByText("Please also check the webhook.")).toBeTruthy();
  expect(within(feed).getByText("And the receipts.")).toBeTruthy();
  expect(within(feed).queryByText(/^Sent (by|from) /)).toBeNull();
});
