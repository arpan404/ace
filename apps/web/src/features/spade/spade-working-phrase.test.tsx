import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** Scout mid-reply, as Spade lists it before the model has said anything: thinking. */
function thinking(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const scout = spade.addAgent({ id: "scout", name: "Scout" });
  spade.store(scout.conversation, { type: "user_message", text: "Find me a flight" });
  spade.store(scout.conversation, { type: "reply_started", reply: "r1" });
  spade.status(scout, "working", "Thinking");
}

async function openScout() {
  const opened = await spadeApp("/spade/scout", thinking);
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Scout" }));
  const say = (status: string) =>
    opened.app.daemon.spade.emit("/v1/conversations/c-scout/live", "status", {
      state: "working",
      status,
    });
  return { ...opened, chat, say };
}

/** Scout's list row: its name, then its line. */
const rowLine = async () => (await botRow("Scout")).textContent ?? "";

const line = (chat: ReturnType<typeof within>) => chat.getByRole("status").textContent ?? "";

test("a bot that is only thinking reads Working, never Thinking alone", async () => {
  const { chat } = await openScout();
  await waitFor(() => expect(line(chat)).toMatch(/^Working/));
  expect(line(chat)).not.toMatch(/Thinking/);
});

test("the line says the bot's own words, and holds each phrase before the next", async () => {
  const { chat, say } = await openScout();
  say("Comparing flight prices");
  await chat.findByText("Comparing flight prices");
  say("Searching the web for flights");
  // The phrase just shown stays up a moment rather than flickering to the next.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(chat.queryByText("Comparing flight prices")).not.toBeNull();
  expect(chat.queryByText("Searching the web for flights")).toBeNull();
  await chat.findByText("Searching the web for flights");
});

test("a phrase from the model is plain text, cut to a few words", async () => {
  const { chat, say } = await openScout();
  say("**Checking** the forecast for Oxford and London today");
  await chat.findByText("Checking the forecast for Oxford");
  say("<img src=x onerror=alert(1)>");
  await waitFor(() => expect(line(chat)).toMatch(/^<img src=x/));
  expect(document.querySelector('img[src="x"]')).toBeNull();
});

test("the list row says the same phrase, holds it, and a question for the person wins at once", async () => {
  const { spade, chat, say } = await openScout();
  await waitFor(async () => expect(await rowLine()).toBe("ScoutWorking"));
  say("Comparing flight prices");
  await waitFor(async () => expect(await rowLine()).toBe("ScoutComparing flight prices"));
  say("Searching the web for flights");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await rowLine()).toBe("ScoutComparing flight prices");
  await waitFor(async () => expect(await rowLine()).toBe("ScoutSearching the web for flights"));
  // A question for the person shows the moment it comes, held phrase or not.
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
  await chat.findByRole("group", { name: /Window or aisle\?/ });
  expect(await rowLine()).toBe("ScoutAsked you a question");
});
