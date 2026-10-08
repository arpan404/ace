import { expect, test } from "vitest";
import { OpenCodeTranslator } from "@ace/adapter-opencode";
import { historyReplyFrames } from "@ace/adapter-opencode/testing";
import { ClientMessage, HistorySession, ThreadId, type ServerMessage } from "@ace/protocol";
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

test("importing saved messages retains their source times instead of the import clock", async () => {
  const daemon = new FakeDaemon({ clock: () => 900_000 });
  daemon.seedServices({
    history: [
      HistorySession.parse({
        id: "saved",
        instanceId: "codex",
        provider: "codex",
        nativeId: "native",
        cwd: "/fake/project",
        title: "Earlier work",
        lastActivity: 2000,
        messageCount: 2,
        countAccuracy: "exact",
        support: { status: "supported" },
      }),
    ],
    historyTranscripts: {
      saved: [
        { role: "user", text: "Start", at: 1000 },
        { role: "assistant", text: "Finished", at: 2000 },
      ],
    },
  });
  const replies: ServerMessage[] = [];
  const session = daemon.session((message) => replies.push(message));
  session.authenticated?.("reader");
  try {
    await session.handle(
      ClientMessage.parse({
        type: "history.import",
        sourceId: "saved",
        workspaceId: "project",
        requestId: "import",
      }),
      "reader",
    );
    const reply = replies.find((message) => message.type === "history.import");
    if (reply?.type !== "history.import" || reply.status !== "imported")
      throw new Error("Import failed");
    const view = daemon.snapshot({ kind: "thread", threadId: reply.threadId });
    if (view?.kind !== "thread") throw new Error("Missing imported transcript");
    expect(
      Object.values(view.items)
        .filter((item) => item.type === "message")
        .map((item) => item.createdAt),
    ).toEqual([1000, 2000]);
  } finally {
    session.close();
  }
});
