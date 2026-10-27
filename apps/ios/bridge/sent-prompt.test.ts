import { connect, fixture, latest, open, reset, until } from "./thread-harness.ts";
import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { readSentPrompt } from "./sent-prompt.ts";

afterEach(reset);

test("Previous message walks back through what the person sent, newest first", async () => {
  const fake = fixture();
  fake.createThread({ id: "recall", workspaceId: "ace", title: "Recall", provider: "codex" });
  fake.apply("recall", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "first", "user", "Fix the flaky test"),
    facts.message("root", "reply", "assistant", "Done."),
    facts.endTurn("root"),
    facts.turn("root"),
    facts.message("root", "second", "user", "Now run lint"),
    facts.endTurn("root"),
  ]);
  const owner = connect(fake);
  open(owner, "recall");
  await until(() => latest("thread.ready"), "the thread");
  const threadId = ThreadId.parse("recall");
  expect(readSentPrompt(owner, { type: "thread.sentText", threadId, older: 0 }).text).toBe(
    "Now run lint",
  );
  expect(readSentPrompt(owner, { type: "thread.sentText", threadId, older: 1 }).text).toBe(
    "Fix the flaky test",
  );
  expect(readSentPrompt(owner, { type: "thread.sentText", threadId, older: 2 }).text).toBeNull();
});
