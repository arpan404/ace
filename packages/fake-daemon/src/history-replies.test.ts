import { expect, test } from "vitest";
import { OpenCodeTranslator } from "@ace/adapter-opencode";
import { historyReplyFrames } from "@ace/adapter-opencode/testing";
import { ThreadId } from "@ace/protocol";
import { FakeDaemon } from "./index.ts";

test("OpenCode history after a new prompt updates the existing fake transcript answer", () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const id = ThreadId.parse("history-replies");
  daemon.createThread({ id, workspaceId: "project", provider: "opencode", title: "History" });
  const translator = new OpenCodeTranslator({ threadId: id, rootKey: "root" });
  const frames = historyReplyFrames();
  for (const frame of [...frames.initial, ...frames.next])
    daemon.apply(id, translator.translate(frame, frame.t));
  const view = daemon.snapshot({ kind: "thread", threadId: id });
  if (view?.kind !== "thread") throw new Error("Missing transcript");
  const answers = Object.values(view.items).filter(
    (item) => item.type === "message" && item.role === "assistant",
  );
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ parts: [{ type: "text", text: "Delegation summary" }] });
});
