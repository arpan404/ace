import { expect, test } from "vitest";
import { spadeProblemStep, spadeRequestWords } from "./index.ts";

test("an email request names who it goes to and the first line it says, with Send and Don't send", () => {
  const words = spadeRequestWords(
    "send_email",
    {
      to: { name: "Marta Reyes", email: "marta@example.com" },
      body: "\nHi Marta,\nThursday works.",
    },
    "Inbox",
  );
  expect(words).toEqual({
    title: "Inbox wants to send an email to Marta Reyes",
    detail: "Hi Marta,",
    allow: "Send",
    deny: "Don't send",
  });
});

test("a command shows itself and is run or not", () => {
  const words = spadeRequestWords("shell", { command: "rm -rf build" }, "Release notes");
  expect(words.title).toBe("Release notes wants to run a command");
  expect(words.detail).toBe("rm -rf build");
  expect([words.allow, words.deny]).toEqual(["Run", "Don't run"]);
});

test("many recipients are counted, and a call with nothing to show has no detail", () => {
  expect(spadeRequestWords("send_email", { to: ["a@x", "b@x", "c@x"] }, "Inbox").title).toBe(
    "Inbox wants to send an email to a@x and 2 others",
  );
  const other = spadeRequestWords("calendar_add", { when: 3 }, "Spade");
  expect(other.detail).toBeUndefined();
  expect([other.allow, other.deny]).toEqual(["Allow", "Deny"]);
});

test("a signed-out bot's list line says the next step; anything else, its first sentence", () => {
  expect(spadeProblemStep("Codex is signed out. Sign in to it in ace, then send again.")).toBe(
    "Sign in to Codex to go on",
  );
  expect(spadeProblemStep("Claude Code is out of quota. It resets at 18:00.")).toBe(
    "Claude Code is out of quota",
  );
});
