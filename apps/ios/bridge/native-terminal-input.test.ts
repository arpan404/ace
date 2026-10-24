// oxlint-disable-next-line import/no-unassigned-import -- Install the test host before the bridge reads it.
import "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { NativeServices } from "./native-services.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
});

async function openTerminal(name: string) {
  const { client, daemon } = sheetFixture();
  close = () => client.close();
  const threadId = ThreadId.parse(name);
  daemon.createThread({ id: threadId, workspaceId: "ace", provider: "codex", title: name });
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const opened = await client.request({
    type: "terminal.request",
    operation: { op: "open", threadId },
  });
  const terminalId = opened.terminal?.id;
  if (!terminalId) throw new Error("terminal not opened");
  const sink = new RecordingSink();
  return { daemon, threadId, terminalId, sink, services: new NativeServices(client, sink) };
}

test("keys and text typed on the phone reach the terminal as one write, in order", async () => {
  const { daemon, threadId, terminalId, sink, services } = await openTerminal("keys-thread");
  services.handle({
    type: "service",
    id: "typed",
    request: {
      type: "terminal.input",
      threadId,
      terminalId,
      applicationCursor: true,
      input: [
        { text: "vim" },
        { key: "Enter" },
        { key: "ArrowUp" },
        { key: "c", ctrl: true },
        { key: "Escape" },
        { key: "b", alt: true },
        { key: "Shift", shift: true },
        { key: "Tab" },
      ],
    },
  });
  await until(() => sink.read("service:typed") !== undefined, "typed");
  expect(sink.read("service:typed")).toMatchObject({ ok: true, value: { ok: true } });
  expect(daemon.terminals.received).toEqual([
    { id: terminalId, data: "vim\r\x1bOA\x03\x1b\x1bb\t" },
  ]);
});

test("cursor keys follow the screen mode the phone reports", async () => {
  const { daemon, threadId, terminalId, sink, services } = await openTerminal("mode-thread");
  services.handle({
    type: "service",
    id: "arrows",
    request: {
      type: "terminal.input",
      threadId,
      terminalId,
      applicationCursor: false,
      input: [{ key: "ArrowLeft" }, { key: "Home" }],
    },
  });
  await until(() => sink.read("service:arrows") !== undefined, "arrows");
  expect(daemon.terminals.received.at(-1)?.data).toBe("\x1b[D\x1b[H");
});
