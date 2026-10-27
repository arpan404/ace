import { connect, fixture, reset, until } from "./thread-harness.ts";
import { facts } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { readNativeThreadFiles, readNativeTurns } from "./native-thread-index.ts";

/*
 * The thread menu's Turns and Attachments lists over the real SDK and the fake daemon: turns
 * newest first with their ask and reply at a glance, and the thread's stored files, which can be
 * removed. No provider CLI runs.
 */

afterEach(reset);

const signal = () => new AbortController().signal;
/** The phone's connection to the fake daemon, once it is ready. */
async function connected() {
  const owner = connect(threeTurns());
  await until(() => owner.state === "ready", "the connection");
  return owner;
}
const id = ThreadId.parse("long");

function threeTurns() {
  const fake = fixture();
  fake.createThread({ id, workspaceId: "ace", title: "Long", provider: "codex" });
  for (const [index, ask] of ["Plan it", "Build it", "Ship it"].entries())
    fake.apply(id, [
      ...(index === 0 ? [facts.rootAgent("codex")] : []),
      { type: "turn.started", agent: "root", nativeTurnId: `t${index}`, trigger: "user" },
      facts.message("root", `ask-${index}`, "user", ask),
      facts.message("root", `answer-${index}`, "assistant", `${ask}: done.\nMore detail.`),
      { type: "turn.ended", agent: "root", nativeTurnId: `t${index}`, outcome: "completed" },
    ]);
  fake.seedServices({ attachmentImages: [{ threadId: id, name: "screen.png" }] });
  return fake;
}

test("turns list newest first, each with its ask and the reply's opening on one line", async () => {
  const owner = await connected();
  const page = await readNativeTurns(owner, { type: "native.turns", threadId: id }, signal());
  expect(page.turns.map((turn) => [turn.ordinal, turn.ask])).toEqual([
    [3, "Ship it"],
    [2, "Build it"],
    [1, "Plan it"],
  ]);
  expect(page.turns[0]?.reply).toBe("Ship it: done. More detail.");
  expect(page.older).toBeNull();
});

test("the thread's stored files list with their size, and a removed one leaves the list", async () => {
  const owner = await connected();
  const request = { type: "native.threadFiles" as const, threadId: id };
  const listed = await readNativeThreadFiles(owner, request, signal());
  expect(listed.files).toHaveLength(1);
  const shown = listed.files[0];
  expect(shown).toMatchObject({ name: "screen.png", kind: "image", mimeType: "image/png" });
  expect(shown?.size).toMatch(/B$/);
  const left = await readNativeThreadFiles(owner, { ...request, release: shown?.ref }, signal());
  expect(left.files).toEqual([]);
});
