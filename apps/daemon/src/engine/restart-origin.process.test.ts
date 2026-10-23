import { afterEach, expect, test } from "vitest";
import { fixture, cleanupRecovery, replaceProvider, crashCopy } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";
import { restartContinuation } from "./restart-resume.ts";
afterEach(cleanupRecovery);

test("continuing after a restart sends one ace-originated restart continuation, its echo folded in", async () => {
  const frames = scriptFrames();
  const continuation = restartContinuation([]);
  const h = await fixture([{ on: "send", frames: [frames.frame(start)] }], frames);
  const id = await h.create();
  const replacement = replaceProvider(h, frames, [
    {
      on: "send",
      frames: [
        frames.frame(
          start,
          {
            type: "item.upsert",
            agent: "root",
            item: "continue-echo",
            draft: {
              type: "message",
              role: "user",
              parts: [{ type: "text", text: continuation }],
              complete: true,
              synthetic: false,
            },
          },
          end,
        ),
      ],
    },
  ]);
  const recovered = await crashCopy(h);
  await recovered.engine.flush();
  expect(replacement.commands.filter((command) => command.type === "send")).toEqual([
    { type: "send", input: [{ type: "text", text: continuation }], delivery: "queue" },
  ]);
  const items = Object.values(recovered.store.snapshotThread(id).items);
  expect(
    items.filter((item) => item.type === "message" && item.origin?.kind === "restart"),
  ).toEqual([
    expect.objectContaining({ synthetic: true, parts: [{ type: "text", text: continuation }] }),
  ]);
  // The provider's echo is the same input, not a second message.
  expect(
    items.filter(
      (item) =>
        item.type === "message" &&
        item.parts.some((part) => part.type === "text" && part.text === continuation),
    ),
  ).toHaveLength(1);
});
