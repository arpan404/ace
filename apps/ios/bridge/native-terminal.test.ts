import { afterEach, expect, test } from "vitest";
import { TerminalOutput, ThreadId } from "@ace/protocol";
import { NativeTerminal } from "./native-terminal.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
});

test("terminal output waits for native credit and the closed sheet stops receiving output", async () => {
  const { client, daemon } = sheetFixture();
  close = () => client.close();
  const threadId = ThreadId.parse("terminal-thread");
  daemon.createThread({ id: threadId, workspaceId: "ace", provider: "codex", title: "Terminal" });
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const opened = await client.request({
    type: "terminal.request",
    operation: { op: "open", threadId },
  });
  const terminalId = opened.terminal?.id;
  if (!terminalId) throw new Error("terminal not opened");
  const sink = new RecordingSink();
  const bridge = new NativeTerminal(client, sink);
  bridge.handle({ type: "terminal.watch", id: "native-stream", threadId, terminalId, offset: 0 });
  const key = "terminal:native-stream:data";
  await until(() => sink.read(key) !== undefined, "initial output");
  const first = sink.read(key);
  expect(first).toMatchObject({ type: "terminal.output", event: { type: "data" } });
  const firstEvent = TerminalOutput.shape.event.parse(first?.["event"]);
  if (firstEvent.type !== "data") throw new Error("Expected initial data");
  await client.request({
    type: "terminal.request",
    operation: { op: "write", threadId, terminalId, data: "pwd\r" },
  });
  expect(sink.read(key)).toEqual(first);
  bridge.handle({ type: "terminal.credit", id: "native-stream", offset: firstEvent.endOffset });
  await until(() => {
    const event = TerminalOutput.shape.event.parse(sink.read(key)?.["event"]);
    return event.type === "data" && event.endOffset > firstEvent.endOffset;
  }, "credited output");
  expect(sink.read(key)).toMatchObject({ event: { type: "data", offset: firstEvent.endOffset } });
  bridge.handle({ type: "terminal.unwatch", id: "native-stream" });
  const last = sink.read(key);
  await client.request({
    type: "terminal.request",
    operation: { op: "write", threadId, terminalId, data: "pwd\r" },
  });
  expect(sink.read(key)).toEqual(last);
});
