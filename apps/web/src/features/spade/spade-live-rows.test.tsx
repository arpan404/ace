import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** Scout, mid-reply, as Spade last listed it: thinking. */
function thinking(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const scout = spade.addAgent({ id: "scout", name: "Scout" });
  spade.store(scout.conversation, { type: "user_message", text: "Book a flight" });
  spade.store(scout.conversation, { type: "reply_started", reply: "r1" });
  spade.status(scout, "working", "Thinking");
}

/** Scout's chat open, its row beside it. */
async function openScout() {
  const opened = await spadeApp("/spade/scout", thinking);
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Scout" }));
  await waitFor(async () => expect((await botRow("Scout")).textContent).toBe("ScoutThinking"));
  return { ...opened, chat };
}

/** A frame on Scout's live stream only: what Spade lists for it stays as it was. */
const frame = (app: Awaited<ReturnType<typeof spadeApp>>["app"], event: string, data: unknown) =>
  app.daemon.spade.emit("/v1/conversations/c-scout/live", event, data);

/** Scout asks a card in its open reply; the roster isn't told. */
function asks(spade: FakeSpadeApi) {
  spade.store("c-scout", {
    type: "step_finished",
    reply: "r1",
    text: "",
    calls: [{ id: "q1", name: "ask_user" }],
  });
  spade.store("c-scout", {
    type: "question_asked",
    reply: "r1",
    call_id: "q1",
    question: "Window or aisle?",
  });
}

test("the list row shows waiting on you while a question is open, as the chat does", async () => {
  const { spade, chat } = await openScout();
  asks(spade);
  await chat.findByRole("group", { name: /Window or aisle\?/ });
  // Spade still lists Scout as thinking; the row says what the chat shows.
  expect(spade.agents.find((agent) => agent.id === "scout")?.status).toBe("Thinking");
  await waitFor(async () =>
    expect((await botRow("Scout")).textContent).toBe("ScoutAsked you a question"),
  );
});

test("the row works again as soon as the person's answer arrives, as the chat does", async () => {
  const { app, spade, chat } = await openScout();
  asks(spade);
  await waitFor(async () =>
    expect((await botRow("Scout")).textContent).toBe("ScoutAsked you a question"),
  );
  const scout = spade.agents.find((agent) => agent.id === "scout");
  if (scout) Object.assign(scout, { state: "waiting", waiting_for: "question", status: null });
  spade.store("c-scout", {
    type: "question_answered",
    reply: "r1",
    call_id: "q1",
    answers: [{ question: "Window or aisle?", answer: "Aisle" }],
  });
  frame(app, "status", { state: "working", status: "Writing" });
  await chat.findByText("Writing");
  // Spade still lists Scout as asking; the row has already moved on with the chat.
  await waitFor(async () => expect((await botRow("Scout")).textContent).toBe("ScoutWriting"));
});

test("the row rests once the stream says the reply ended, though Spade still lists it working", async () => {
  const { app, spade, chat } = await openScout();
  spade.store("c-scout", { type: "step_finished", reply: "r1", text: "Booked the aisle seat." });
  spade.store("c-scout", { type: "reply_finished", reply: "r1", text: "Booked the aisle seat." });
  frame(app, "status", { state: "idle", status: null });
  await chat.findByText("Booked the aisle seat.");
  await waitFor(async () => expect((await botRow("Scout")).textContent).not.toMatch(/Thinking$/));
  expect(chat.queryByRole("status")).toBeNull();
});
