import { afterEach, expect, test } from "vitest";
import { fixture, cleanupRecovery, replaceProvider, crashCopy } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";
afterEach(cleanupRecovery);

test("automatic restart sends only continue as one ace-originated input without a notice", async () => {
  const frames = scriptFrames();
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
              parts: [{ type: "text", text: "continue" }],
              complete: true,
              synthetic: false,
            },
          },
          end,
        ),
      ],
    },
  ]);
  const recovered = await crashCopy(h, { preferences: { continueAfterRestart: true } });
  await recovered.engine.flush();
  expect(replacement.commands.filter((command) => command.type === "send")).toEqual([
    { type: "send", input: [{ type: "text", text: "continue" }], delivery: "queue" },
  ]);
  const items = Object.values(recovered.store.snapshotThread(id).items);
  expect(
    items.filter((item) => item.type === "message" && item.origin?.kind === "restart"),
  ).toEqual([
    expect.objectContaining({ synthetic: true, parts: [{ type: "text", text: "continue" }] }),
  ]);
  expect(
    items.some(
      (item) =>
        item.type === "notice" &&
        /ace restarted|previous provider process stopped/i.test(item.text),
    ),
  ).toBe(false);
});
