import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

test("a note says where it came from, and everything from that source can be forgotten", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) => {
    withEndpoint(api);
    api.addAgent({
      id: "main",
      kind: "main",
      name: "Spade",
      avatar: { kind: "spade" },
      model: "openrouter/anthropic/sonnet",
    });
    const travel = api.addAgent({
      id: "travel",
      name: "Travel",
      model: "openrouter/anthropic/sonnet",
    });
    const note = api.notes.add({ text: "Prefers aisle seats", agent: "travel", source: "bot" });
    const source = {
      key: `conversation:${travel.conversation}`,
      label: "Your conversation with Travel",
    };
    api.provenance.set(note.id, {
      text: note.text,
      sources: [source],
      conversation: { id: travel.conversation, agent: "travel", name: "Travel" },
      message: { seq: 1, at: Date.now(), text: "I like aisle seats" },
      call: "c1",
      source: "bot",
      at: Date.now(),
      trust: "kept",
    });
    api.learned.set("travel", [{ ...source, notes: 1, entries: 0 }]);
  });
  await screen.findByRole("feed", { name: "Conversation with Travel" });
  await openProfile("Travel");
  const profile = within(await screen.findByRole("region", { name: "Travel's profile" }));
  await userEvent.click(profile.getByRole("tab", { name: "Library" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Where it's from: Prefers aisle seats" }),
  );
  const why = within(await screen.findByRole("dialog", { name: "Where it's from" }));
  await why.findByText(/^Learned in your conversation with Travel/);
  expect(why.getByText("Answering your message “I like aisle seats”")).toBeTruthy();
  await userEvent.click(
    why.getByRole("button", { name: "Forget everything from your conversation with Travel" }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Forget all of it" }));
  await waitFor(() =>
    expect(spade.forgotSources).toEqual([
      { agent: "travel", source: expect.stringMatching(/^conversation:/) },
    ]),
  );
});

test("Correct this under a reply opens that same note right there to rewrite", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) => {
    withEndpoint(api);
    api.addAgent({
      id: "main",
      kind: "main",
      name: "Spade",
      avatar: { kind: "spade" },
      model: "openrouter/anthropic/sonnet",
    });
    const travel = api.addAgent({
      id: "travel",
      name: "Travel",
      model: "openrouter/anthropic/sonnet",
    });
    const note = api.notes.add({ text: "Prefers window seats", agent: "travel", source: "bot" });
    api.provenance.set(note.id, {
      text: note.text,
      sources: [],
      source: "bot",
      at: Date.now(),
      trust: "kept",
    });
    const c = travel.conversation;
    api.store(c, {
      type: "user_message",
      text: "Book my flight",
      context: `- [${note.id}] Prefers window seats`,
    });
    api.store(c, { type: "reply_started", reply: "r1" });
    api.store(c, { type: "step_finished", reply: "r1", text: "Booked a window seat." });
    api.store(c, {
      type: "reply_finished",
      reply: "r1",
      text: "Booked a window seat.",
      cost_micros: 0,
    });
  });
  const feed = within(await screen.findByRole("feed", { name: "Conversation with Travel" }));
  await userEvent.click(await feed.findByText("Had a note in mind"));
  await userEvent.click(
    await feed.findByRole("button", { name: "Where it's from: Prefers window seats" }),
  );
  const why = within(await screen.findByRole("dialog", { name: "Where it's from" }));
  await userEvent.click(await why.findByRole("button", { name: "Correct this" }));
  // Still in the conversation: the note itself is open to change, nothing else opened.
  const field = await feed.findByRole("textbox", { name: "Correct the note" });
  expect((field as HTMLTextAreaElement).value).toBe("Prefers window seats");
  await userEvent.clear(field);
  await userEvent.type(field, "Prefers aisle seats");
  await userEvent.click(feed.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.notes.notes.find((note) => note.agent === "travel")?.text).toBe(
      "Prefers aisle seats",
    ),
  );
  expect(feed.queryByRole("textbox", { name: "Correct the note" })).toBeNull();
});
