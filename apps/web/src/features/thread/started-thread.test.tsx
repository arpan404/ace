import { startedConversation, startedConversationIds } from "@ace/fake-daemon";
import { AgentId, RunId, ThreadId } from "@ace/protocol";
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
  // An agent row: the thread's title, "New thread · project", its status where it started.
  expect(card.textContent).toMatch(/Separate Codex chatNew thread · .+/);
  expect(card.querySelector("[data-tone]")).not.toBeNull();
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

/** The same conversation, made by the agent's `thread_fork`: a fork of the source thread. */
function forkedConversation() {
  const [source, started] = JSON.parse(
    JSON.stringify(startedConversation()).replaceAll("thread_start", "thread_fork"),
  ) as ReturnType<typeof startedConversation>;
  if (!source || !started) throw new Error("No scenario");
  started.thread = {
    ...started.thread,
    lineage: {
      parentThreadId: ThreadId.parse(startedConversationIds.source),
      parentAgentId: AgentId.parse(`${startedConversationIds.source}.root`),
      point: { type: "turn", runId: RunId.parse("run-1") },
      mode: "portable",
      lossy: true,
    },
  };
  return [source, started];
}

test("a fork an agent made reads as one quiet line linking to it, not as an agent of this thread", async () => {
  const app = harness();
  for (const scenario of forkedConversation()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${startedConversationIds.source}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const link = await within(feed).findByRole("link", { name: "Separate Codex chat" });
  expect(link.closest('[role="note"]')?.textContent).toBe("Forked to Separate Codex chat");
  expect(within(feed).queryByRole("region", { name: /Separate Codex chat/ })).toBeNull();
  await userEvent.click(link);
  expect(
    await within(await screen.findByRole("feed", { name: "Transcript" })).findByText(welcome),
  ).toBeTruthy();
});
