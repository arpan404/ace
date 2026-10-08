import { OpenCodeTranslator } from "@ace/adapter-opencode";
import { historyReplyFrames } from "@ace/adapter-opencode/testing";
import { ThreadId } from "@ace/protocol";
import { act, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("a new question and provider history replay show the previous answer once through the worker", async () => {
  const app = harness({ throughWorker: true });
  const id = ThreadId.parse("history-replies");
  app.daemon.createThread({ id, workspaceId: "docs-site", provider: "opencode", title: "History" });
  const translator = new OpenCodeTranslator({ threadId: id, rootKey: "root" });
  const frames = historyReplyFrames();
  for (const frame of frames.initial) app.daemon.apply(id, translator.translate(frame, frame.t));
  await app.open(`/t/${id}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Delegation summary");
  await act(async () => {
    for (const frame of frames.next) app.daemon.apply(id, translator.translate(frame, frame.t));
  });
  await within(feed).findByText("List downloads");
  expect(within(feed).getAllByText("Delegation summary")).toHaveLength(1);
  await act(async () => app.daemon.disconnectAll());
  await within(feed).findByText("List downloads");
  expect(within(feed).getAllByText("Delegation summary")).toHaveLength(1);
});
