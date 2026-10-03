import { longHistory, replayCursor } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

async function open(scenario: "idle" | "busy") {
  const app = harness();
  if (scenario === "idle") app.play(longHistory(2)).runUntilBlocked();
  else app.play(replayCursor()).runThrough("finding");
  await app.open(scenario === "idle" ? "/t/thread-router" : "/t/thread-replay-cursor");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });
  return { app, feed, message };
}

test("a message sent to a settled thread lands in the transcript and the agent starts work", async () => {
  const { feed, message } = await open("idle");
  await userEvent.type(message, "Add a route for /settings{Enter}");
  expect(await within(feed).findByText("Add a route for /settings")).toBeTruthy();
  expect((message as HTMLTextAreaElement).value).toBe("");
  // The agent is busy now, so an empty composer offers Stop instead of Send.
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
});

test("while the agent works, Enter queues the message until the agent is free", async () => {
  const { feed, message } = await open("busy");
  await userEvent.type(message, "Also check the iOS cold-start path{Enter}");
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  expect(within(queue).getByText("Also check the iOS cold-start path")).toBeTruthy();
  expect(within(feed).queryByText("Also check the iOS cold-start path")).toBeNull();

  // Stopping frees the agent; the daemon then delivers the queued message.
  await userEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
  expect(await within(feed).findByText("Also check the iOS cold-start path")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
});

test("⌘↵ steers the running turn instead of queueing", async () => {
  const { feed, message } = await open("busy");
  await userEvent.type(message, "Cap it at 500 instead{Meta>}{Enter}{/Meta}");
  expect(await within(feed).findByText("Cap it at 500 instead")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull();
});

test("@ completes files from the checkout and the pick is sent with the message", async () => {
  const { feed, message } = await open("idle");
  await userEvent.type(message, "Look at @check");
  const files = await screen.findByRole("listbox", { name: "Files" });
  expect(within(files).getAllByRole("option")[0]?.textContent).toContain(
    "src/checkout/checkout.spec.ts",
  );
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect((message as HTMLTextAreaElement).value).toBe("Look at @src/checkout/payment-poller.ts ");
  expect(screen.queryByRole("listbox", { name: "Files" })).toBeNull();

  await userEvent.type(message, "first{Enter}");
  expect(
    await within(feed).findByText("Look at @src/checkout/payment-poller.ts first"),
  ).toBeTruthy();
});

test("a leading / lists commands; Escape dismisses the list", async () => {
  const { message } = await open("idle");
  await userEvent.type(message, "/re");
  const commands = await screen.findByRole("listbox", { name: "Commands" });
  expect(within(commands).getByRole("option", { selected: true }).textContent).toContain("/review");
  await userEvent.keyboard("{Tab}");
  expect((message as HTMLTextAreaElement).value).toBe("/review ");

  await userEvent.clear(message);
  await userEvent.type(message, "/p");
  await screen.findByRole("listbox", { name: "Commands" });
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  expect((message as HTMLTextAreaElement).value).toBe("/p");
});

test("attached files upload before sending and can be removed", async () => {
  const { feed } = await open("idle");
  const send = screen.getByRole("button", { name: "Send" });
  expect(send.hasAttribute("disabled")).toBe(true);

  const input = screen.getByLabelText("Files to attach");
  await userEvent.upload(input, [
    new File(["replay log"], "replay.log", { type: "text/plain" }),
    new File(["x"], "trace.txt", { type: "text/plain" }),
  ]);
  const chips = screen.getByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("status")).toBeNull());
  expect(send.hasAttribute("disabled")).toBe(false);

  await userEvent.click(within(chips).getByRole("button", { name: "Remove trace.txt" }));
  expect(within(chips).queryByText("trace.txt")).toBeNull();
  expect(within(chips).getByText("replay.log")).toBeTruthy();

  await userEvent.click(send);
  expect(await within(feed).findByText("See the attached files.")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
});

test("the model picker shows each account's usage and blocks an exhausted one", async () => {
  await open("busy");
  await userEvent.click(await screen.findByRole("button", { name: "Model: Opus 4.1, Personal" }));
  const work = await screen.findByRole("menuitemradio", { name: "Opus 4.1 · Work" });
  expect(
    within(work).getByRole("meter", { name: "Work usage" }).getAttribute("aria-valuenow"),
  ).toBe("57");
  expect(work.textContent).toContain("57% of Weekly window used");
  const team = screen.getByRole("menuitemradio", { name: "GPT-5 Codex · Team" });
  expect(team.getAttribute("aria-disabled")).toBe("true");
  expect(team.textContent).toMatch(/Limit reached · resets \d\d:\d\d/);

  await userEvent.click(screen.getByRole("menuitemradio", { name: "Sonnet 4.5 · Personal" }));
  expect(await screen.findByRole("button", { name: "Model: Sonnet 4.5, Personal" })).toBeTruthy();
});

test("the context bar shows the checkout and switches branch", async () => {
  await open("busy");
  expect(await screen.findByRole("link", { name: /#214/ })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Branch: fix/replay-cursor" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "main" }));
  expect(await screen.findByRole("button", { name: "Branch: main" })).toBeTruthy();
});
