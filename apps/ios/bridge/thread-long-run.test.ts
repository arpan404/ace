import { afterEach, expect, test, vi } from "vitest";
import { facts } from "@ace/fake-daemon";
import { connect, fixture, native, open, pump, reset, rows, until } from "./thread-harness.ts";
import { ThreadVisit } from "./thread-visit.ts";

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

test("streaming into an open thread sends bytes proportional to the new text", async () => {
  const fake = fixture();
  fake.createThread({ id: "live", workspaceId: "ace", title: "Live", provider: "codex" });
  fake.apply("live", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message(
      "root",
      "answer",
      "assistant",
      "An earlier line of the answer. ".repeat(400),
      false,
    ),
  ]);
  const client = connect(fake);
  const visit = new ThreadVisit(pump, { opened() {}, leaving() {} });
  const emit = vi.spyOn(globalThis.aceHost, "emit");
  try {
    visit.open(client, "live", false);
    await until(() => native.frames.some((frame) => frame.type === "thread.ready"), "the thread");
    await pump.drained();
    emit.mockClear();

    const count = 20;
    let deltaBytes = 0;
    for (let index = 0; index < count; index++) {
      const append = ` Next step ${index}: continue the review.`;
      deltaBytes += Buffer.byteLength(append);
      const start = native.frames.length;
      fake.apply("live", [facts.stream("root", "answer", append)]);
      await until(
        () =>
          native.frames.slice(start).some((patch) => {
            if (patch.type === "thread.item.text") return patch.append === append;
            if (patch.type !== "thread.item" || !patch.row || typeof patch.row !== "object")
              return false;
            const text: unknown = Reflect.get(patch.row, "text");
            return typeof text === "string" && text.endsWith(append);
          }),
        `delta ${index} on the native bridge`,
      );
      await pump.drained();
    }
    const bytes = emit.mock.calls.reduce((total, [frame]) => total + Buffer.byteLength(frame), 0);
    // The fixture emits 100 deltas in each five-second window. Allow 400 bytes per delta,
    // including its envelope and cursor, irrespective of how much text was already visible.
    expect(bytes).toBeLessThan(count * 400);
    expect(bytes).toBeGreaterThanOrEqual(deltaBytes);
  } finally {
    emit.mockRestore();
    visit.back();
  }
});
