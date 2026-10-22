import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { connect, fixture, native, open, reset, rows, until } from "./thread-harness.ts";

/*
 * A thread that has streamed for hours paints as fast as a new one, over the real SDK and the
 * fake daemon (`thread-harness.ts`): its first window never carries the whole of a long text.
 */

afterEach(reset);

test("a thread whose answer streamed past the wire's frame size paints its newest text at once", async () => {
  const fake = fixture();
  fake.createThread({ id: "hours", workspaceId: "ace", title: "Hours", provider: "codex" });
  fake.apply("hours", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    // As much text as about 70,000 streamed deltas: one frame of it would close the connection.
    facts.message("root", "stream", "assistant", "Next step. ".repeat(300_000), false),
  ]);
  fake.apply("hours", [facts.stream("root", "stream", " Still going.")]);
  const client = connect(fake);
  const started = Date.now();
  open(client, "hours");
  await until(() => native.frames.some((frame) => frame.type === "thread.ready"), "the thread");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(client.connectionState().getSnapshot()).toBe("ready");
  const answer = rows("thread.item").find(
    (row) => row.type === "message" && row.role === "assistant",
  );
  expect(answer).toMatchObject({ truncated: true });
  expect(String(answer?.text)).toMatch(/Still going\.$/);
});
