import { fixtureImage, longHistory, replayCursor } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { chooseModel, closeModelControl, openModelControl } from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());

/** jsdom has no layout; give every element this width (the setup file's default is 800). */
function layoutWidth(width: number) {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => width,
  });
}
afterEach(() => layoutWidth(800));

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

test("while the thread works, Enter queues the message until nothing is running", async () => {
  const { app, feed, message } = await open("busy");
  await userEvent.type(message, "Also check the iOS cold-start path{Enter}");
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  expect(within(queue).getByText("Also check the iOS cold-start path")).toBeTruthy();
  expect(within(feed).queryByText("Also check the iOS cold-start path")).toBeNull();

  // Stopping the agents leaves the background relay running, so the daemon keeps the message
  // queued; once the relay ends the thread is idle and the queued message is delivered.
  await userEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull());
  expect(within(feed).queryByText("Also check the iOS cold-start path")).toBeNull();
  app.daemon.apply("thread-replay-cursor", [
    { type: "background.ended", task: "relay", status: "stopped" },
  ]);
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
  // Nothing to send yet: the button stays focusable and its tooltip says why.
  expect(send.getAttribute("aria-disabled")).toBe("true");

  const input = screen.getByLabelText("Files to attach");
  const png = Uint8Array.from(atob(fixtureImage.data), (char) => char.charCodeAt(0));
  await userEvent.upload(input, [
    new File([png], "replay.png", { type: "image/png" }),
    new File([png], "trace.png", { type: "image/png" }),
  ]);
  const chips = screen.getByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  expect(send.getAttribute("aria-disabled")).toBeNull();

  await userEvent.click(within(chips).getByRole("button", { name: "Remove trace.png" }));
  expect(within(chips).queryByText("trace.png")).toBeNull();
  expect(within(chips).getByText("replay.png")).toBeTruthy();

  await userEvent.click(send);
  expect(await within(feed).findByText("See the attached files.")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
});

test("the account row moves the thread to another account and blocks one at its limit", async () => {
  await open("busy");
  const popover = await openModelControl(/^Model: Opus 5\.5, personal/);
  const accounts = within(popover).getByRole("group", { name: "Account" });
  expect(within(accounts).getByRole("button", { name: "Account personal" }).ariaPressed).toBe(
    "true",
  );
  await userEvent.click(within(accounts).getByRole("button", { name: "Account work" }));
  expect(await screen.findByRole("button", { name: /^Model: Opus 5\.5, work/ })).toBeTruthy();
  await closeModelControl();

  // GPT-5 Codex on the team account is at its limit: only personal can take it.
  await chooseModel("GPT-5 Codex", "Codex");
  const dialog = await screen.findByRole("dialog", { name: "Switch to Codex?" });
  await userEvent.click(within(dialog).getByRole("button", { name: /^Switch to/ }));
  const codex = await openModelControl(/^Model: GPT-5 Codex, personal/);
  const team = within(codex).getByRole("button", { name: "Account team" });
  expect(team.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(team);
  expect(screen.getByRole("button", { name: /^Model: GPT-5 Codex, personal/ })).toBeTruthy();
});

test("the environment pill shows where the thread runs and follows its branch past a commit", async () => {
  await open("busy");
  const pill = await screen.findByRole("button", {
    name: "Environment: Local · fix/replay-cursor",
  });
  await userEvent.click(pill);
  const card = await screen.findByRole("region", { name: "Where this thread runs" });
  expect(within(card).getByText("Local checkout")).toBeTruthy();
  expect(within(card).getByText("fix/replay-cursor")).toBeTruthy();
  expect(within(card).queryByText(/ahead/)).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Commit" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
  await userEvent.click(within(dialog).getByRole("button", { name: /^Commit/ }));
  expect(await within(card).findByText(/1 ahead/)).toBeTruthy();

  // Escape puts the card away and the caret back in the message.
  const close = within(card).getByRole("button", { name: "Close" });
  // Once the commit dialog has handed focus back.
  await waitFor(() => {
    close.focus();
    expect(document.activeElement).toBe(close);
  });
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Where this thread runs" })).toBeNull(),
  );
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Message" }));
});

test("the composer carries no context or usage meter, whatever the provider reports", async () => {
  const { app } = await open("busy");
  app.daemon.apply("thread-replay-cursor", [
    {
      type: "context.sample",
      agent: "root",
      usedTokens: 168_000,
      windowTokens: 200_000,
      model: "claude-opus-4-6",
    },
  ]);
  await screen.findByRole("button", { name: /^Model: / });
  expect(screen.queryByRole("meter")).toBeNull();
  expect(screen.queryByText(/tokens in context|% used|\d+%$/)).toBeNull();
});

test("a composer squeezed by an open panel keeps its hint to one short line", async () => {
  layoutWidth(500);
  const { message } = await open("idle");
  expect(message.getAttribute("placeholder")).toBe("Ask anything");
});

test("a wide composer spells out the @ and / hints", async () => {
  layoutWidth(900);
  const { message } = await open("idle");
  expect(message.getAttribute("placeholder")).toBe("Ask anything, @ to mention, / for commands");
});

test("a phone-width composer shows approvals by its icon alone, the mode kept in its name", async () => {
  layoutWidth(358);
  await open("busy");
  const approvals = await screen.findByRole("button", { name: /^Approvals: Auto-review/ });
  expect(approvals.textContent).toBe("");
  // The model chip keeps its name; only its effort goes.
  const model = screen.getByRole("button", { name: /^Model: / });
  expect(model.textContent).toContain("Opus 5.5");
  expect(model.textContent).not.toContain("·");
});

test("a wide composer names the approval mode on its chip", async () => {
  layoutWidth(900);
  await open("busy");
  const approvals = await screen.findByRole("button", { name: /^Approvals: Auto-review/ });
  expect(approvals.textContent).toContain("Auto-review");
});
