import { startedConversation, startedConversationIds } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const welcome = /Welcome to the separate chat/;
const threads = async () => within(await screen.findByRole("navigation", { name: "Threads" }));

test("the thread an agent started shows where it was started as a card whose Open takes the person there", async () => {
  const app = harness();
  for (const scenario of startedConversation()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${startedConversationIds.source}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const card = await within(feed).findByRole("region", { name: "New thread: Separate Codex chat" });
  expect(card.textContent).toContain("Codex · Personal · GPT-5.5");
  // The agent relays the summary; the card, not the reply, carries the link.
  expect(within(feed).queryByText(startedConversationIds.started)).toBeNull();
  await userEvent.click(within(card).getByRole("link", { name: "Open Separate Codex chat" }));
  expect(
    await within(await screen.findByRole("feed", { name: "Transcript" })).findByText(welcome),
  ).toBeTruthy();
});

test("an agent-started thread is in the thread list, opens with a usable composer and survives a reload", async () => {
  const app = harness();
  for (const scenario of startedConversation()) app.play(scenario).runUntilBlocked();
  const view = await app.open(`/t/${startedConversationIds.source}`);
  await userEvent.click(
    await (await threads()).findByRole("link", { name: /^Separate Codex chat/ }),
  );
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByText(welcome)).toBeTruthy();
  // Its opening message came from the agent that started it, with the way back.
  expect(within(feed).getByRole("link", { name: /Back to AI in education essay/ })).toBeTruthy();
  const message = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(message, "Draft the release notes{Enter}");
  expect(await within(feed).findByText("Draft the release notes")).toBeTruthy();

  view.unmount();
  await app.client.close();
  const reloaded = harness({ daemon: app.daemon });
  await reloaded.open(`/t/${startedConversationIds.started}`);
  const again = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(again).findByText(welcome)).toBeTruthy();
  expect(await within(again).findByText("Draft the release notes")).toBeTruthy();
  await waitFor(async () =>
    expect((await threads()).getByRole("link", { name: /^Separate Codex chat/ })).toBeTruthy(),
  );
});
