import { afterEach, expect, test } from "vitest";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const imageNote = "[Image: original 1206x2622, displayed at 920x2000.]";
const notification =
  "<task-notification>\n<task-id>b3m9</task-id>\n<status>completed</status>\n</task-notification>";

test("a provider's own note in a woken run keeps no wake origin; the adapter's wake input keeps its", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  cleanups.push(h.close);
  const id = await h.create();
  const ctx = h.contexts[0];
  if (!ctx) throw new Error("Missing session");
  ctx.onFrame(
    frames.frame(
      { type: "turn.started", agent: "root", trigger: "background_completion", nativeTurnId: "w" },
      {
        type: "item.upsert",
        agent: "root",
        item: "wake-input",
        draft: {
          type: "message",
          role: "user",
          synthetic: true,
          origin: { kind: "background_completion" },
          parts: [{ type: "text", text: notification }],
          complete: true,
        },
      },
      {
        type: "item.upsert",
        agent: "root",
        item: "image-note",
        draft: {
          type: "message",
          role: "user",
          synthetic: true,
          parts: [{ type: "text", text: imageNote }],
          complete: true,
        },
      },
      { type: "turn.ended", agent: "root", outcome: "completed", nativeTurnId: "w" },
    ),
  );
  await h.engine.flush();
  const messages = Object.values(h.store.snapshotThread(id).items).filter(
    (item) => item.type === "message" && item.role === "user" && item.synthetic,
  );
  const byText = (text: string) =>
    messages.find(
      (item) =>
        item.type === "message" && item.parts[0]?.type === "text" && item.parts[0].text === text,
    );
  expect(byText(notification)).toMatchObject({ origin: { kind: "background_completion" } });
  expect(byText(imageNote)).toBeDefined();
  expect(byText(imageNote)).not.toHaveProperty("origin");
});
