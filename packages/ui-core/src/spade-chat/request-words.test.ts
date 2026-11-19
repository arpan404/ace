import { expect, test } from "vitest";
import { spadeProblemStep, spadeRequestCard } from "./index.ts";

test("an email request names who it goes to, and shows its recipient, subject and words", () => {
  const card = spadeRequestCard(
    "send_email",
    {
      to: { name: "Marta Reyes", email: "marta@example.com" },
      subject: "Thursday",
      body: "Hi Marta",
    },
    "Inbox",
  );
  expect(card.sentence).toBe("Inbox wants to send an email to Marta Reyes.");
  expect(card.detail).toEqual({
    kind: "email",
    to: "Marta Reyes",
    subject: "Thursday",
    body: "Hi Marta",
  });
  expect(card.always).toBe(false);
});

test("a command reads as running a command, shows itself, and may be allowed always", () => {
  const card = spadeRequestCard("shell", { command: "rm -rf build" }, "Release notes");
  expect(card.sentence).toBe("Release notes wants to run a command.");
  expect(card.detail).toEqual({ kind: "command", command: "rm -rf build" });
  expect(card.always).toBe(true);
});

test("a note's change shows the note as it is and what it becomes", () => {
  const card = spadeRequestCard(
    "memory_update",
    { id: "n_1", text: "Study deck: 14 slides" },
    "Learning",
    { noteText: (id) => (id === "n_1" ? "Study deck: 12 slides" : undefined) },
  );
  expect(card.sentence).toBe("Learning wants to update a note.");
  expect(card.detail).toEqual({
    kind: "note",
    text: "Study deck: 14 slides",
    before: "Study deck: 12 slides",
  });
});

test("a file write names its path, and a deferred tool reads by its connector's title", () => {
  expect(spadeRequestCard("workspace_write", { path: "a.md", content: "x" }, "W").detail).toEqual({
    kind: "file",
    path: "a.md",
    text: "x",
  });
  const card = spadeRequestCard(
    "call_tool",
    { name: "c1__create_event", arguments: { when: "Friday", guests: ["Sam", "Ana"] } },
    "A helper of Planner",
    { title: (name) => (name === "c1__create_event" ? "Calendar create event" : undefined) },
  );
  expect(card.sentence).toBe("A helper of Planner wants to use Calendar create event.");
  expect(card.detail).toEqual({
    kind: "fields",
    fields: [
      { label: "When", value: "Friday" },
      { label: "Guests", value: "Sam, Ana" },
    ],
  });
});

test("a message to another bot names that bot, not its id, and may be allowed always", () => {
  const card = spadeRequestCard("bot_message", { bot: "a_9", text: "When was it?" }, "Spade", {
    botName: (id) => (id === "a_9" ? "Research" : undefined),
  });
  expect(card.sentence).toBe("Spade wants to message another bot.");
  expect(card.detail).toEqual({ kind: "message", to: "Research", text: "When was it?" });
  expect(card.always).toBe(true);
});

test("a signed-out bot's list line says the next step; anything else, its first sentence", () => {
  expect(spadeProblemStep("Codex is signed out. Sign in to it in ace, then send again.")).toBe(
    "Sign in to Codex to go on",
  );
  expect(spadeProblemStep("Claude Code is out of quota. It resets at 18:00.")).toBe(
    "Claude Code is out of quota",
  );
});
