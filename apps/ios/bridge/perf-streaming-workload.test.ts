import { afterEach, expect, test, vi } from "vitest";
import { facts } from "@ace/fake-daemon";
import { connect, fixture, native, pump, reset, until } from "./thread-harness.ts";
import { ThreadVisit } from "./thread-visit.ts";

afterEach(reset);

const next = (delta: number) => ` Next step ${delta}: wire the safe kill-all filters.`;

test("five seconds of answer and command output updates stay within 40 KB", async () => {
  const fake = fixture();
  const id = "ios-stream";
  const seed = 650_000;
  fake.createThread({ id, workspaceId: "ace", title: "Streaming", provider: "codex" });
  fake.apply(id, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    ...Array.from({ length: 1999 }, (_, index) =>
      facts.message(
        "root",
        `history-${index}`,
        index % 5 === 0 ? "user" : "assistant",
        `History ${index + 1}. ${index % 5 === 0 ? "Keep process ownership explicit." : "The daemon records each child process and its kernel start time. Reconnect and replay keep the same canonical facts on every device."}`,
      ),
    ),
    facts.tool("root", "check", {
      kind: "shell",
      title: "Run checks",
      detail: { kind: "shell", command: "bun run check -- " + "input-file.ts ".repeat(640) },
    }),
    facts.output("root", "check", "Starting checks.\n"),
    facts.message("root", "stream", "assistant", "Orphan cleanup.", false),
  ]);
  // The fixture starts 650,000 deltas in. Only its trailing 400 lines are needed
  // to exercise the same already-full 8,192-unit preview during the measured burst.
  const tail = Array.from({ length: 400 }, (_, i) => next(seed - 399 + i)).join("");
  fake.apply(id, [facts.stream("root", "stream", tail)]);

  const client = connect(fake);
  const visit = new ThreadVisit(pump, { opened() {}, leaving() {} });
  const emit = vi.spyOn(globalThis.aceHost, "emit");
  try {
    visit.open(client, id, false);
    await until(() => native.frames.some((frame) => frame.type === "thread.ready"), "thread ready");
    await pump.drained();
    emit.mockClear();
    for (let index = 1; index <= 100; index++) {
      const append = next(seed + index);
      const start = native.frames.length;
      fake.apply(id, [
        facts.stream("root", "stream", append),
        ...(index % 10 === 0 ? [facts.output("root", "check", `Checked file ${index}\n`)] : []),
      ]);
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
    console.info(`PERF_STREAM_BYTES=${bytes}`);
    expect(bytes).toBeLessThan(40_000);

    const outputEdits = native.frames.filter((patch) => patch.field === "stepOutput");
    expect(outputEdits).toHaveLength(10);
    let output = Buffer.from("Starting checks.\n");
    for (const { base, cut, append } of outputEdits) {
      expect(base).toBe(output.byteLength);
      if (typeof cut !== "number" || typeof append !== "string")
        throw new Error("Invalid output edit");
      output = Buffer.concat([output.subarray(cut), Buffer.from(append)]);
    }
    expect(output.toString()).toBe(
      "Starting checks.\n" +
        Array.from({ length: 10 }, (_, index) => `Checked file ${(index + 1) * 10}\n`).join(""),
    );
  } finally {
    emit.mockRestore();
    visit.back();
  }
});
