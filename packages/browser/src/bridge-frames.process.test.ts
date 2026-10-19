import { once } from "node:events";
import { expect, it } from "vitest";
import type { BrowserServerMessage } from "@ace/protocol";
import { connectBrowser } from "./index.ts";
import { backendFixture } from "./backend-test-support.ts";
import { decodeStreamMessage, StreamAssembler, type StreamMessage } from "./stream.ts";

type FrameMessage = Extract<StreamMessage, { kind: "browser.frame" }>;

function viewer(f: Awaited<ReturnType<typeof backendFixture>>, id: string, binary: boolean) {
  const messages: BrowserServerMessage[] = [];
  const streamed: FrameMessage[] = [];
  const assembler = new StreamAssembler();
  const bridge = connectBrowser(f.service, {
    connectionId: id,
    authorize: () => true,
    send: (message) => {
      messages.push(message);
      return true;
    },
    sendStream: (pieces) => {
      for (const piece of pieces) {
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (message?.kind === "browser.frame") streamed.push(message);
      }
      return true;
    },
  });
  const subscribe = () =>
    bridge.handle({
      type: "browser.subscribe",
      threadId: "thread",
      requestId: `${id}-subscribe`,
      ...(binary ? { binaryFrames: true } : {}),
    });
  const ack = (sequence: number) =>
    bridge.handle({ type: "browser.ack", threadId: "thread", requestId: `${id}-ack`, sequence });
  const frames = () => messages.filter((message) => message.type === "browser.frame");
  return { bridge, streamed, subscribe, ack, frames };
}

it("a viewer that asks for binary frames gets the JPEG's bytes, and a JSON viewer still gets base64", async () => {
  const f = await backendFixture();
  await f.open();
  const binary = viewer(f, "phone", true);
  const json = viewer(f, "older-app", false);
  await binary.subscribe();
  await json.subscribe();
  // The page's first frame reaches both, each in the form it asked for.
  expect(binary.frames()).toEqual([]);
  expect(binary.streamed).toHaveLength(1);
  const first = binary.streamed[0];
  const [jsonFirst] = json.frames();
  if (!first || jsonFirst?.type !== "browser.frame") throw new Error("Missing first frames");
  expect(first.threadId).toBe("thread");
  expect(Buffer.from(first.frame.bytes)).toEqual(Buffer.from(jsonFirst.frame.data, "base64"));
  expect(first.frame).toMatchObject({
    sequence: jsonFirst.frame.sequence,
    width: jsonFirst.frame.width,
    height: jsonFirst.frame.height,
  });

  // One frame in flight per viewer: the next frame waits for this viewer's ACK.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const sessionId = [...f.pages.keys()][0];
  if (!sessionId) throw new Error("Missing session");
  const ackSent = once(f.requests, "browser.backend.frameAck");
  f.sendEvent(sessionId, "Page.screencastFrame", {
    sessionId: 1,
    data: jpeg.toString("base64"),
    metadata: { deviceWidth: 1280, deviceHeight: 720 },
  });
  await ackSent;
  expect(binary.streamed).toHaveLength(1);
  await binary.ack(first.frame.sequence);
  expect(binary.streamed).toHaveLength(2);
  expect(Buffer.from(binary.streamed[1]?.frame.bytes ?? [])).toEqual(jpeg);
  binary.bridge.close();
  json.bridge.close();
});

it("a transport without binary messages keeps every viewer on JSON frames", async () => {
  const f = await backendFixture();
  await f.open();
  const messages: BrowserServerMessage[] = [];
  const bridge = connectBrowser(f.service, {
    connectionId: "plain",
    authorize: () => true,
    send: (message) => {
      messages.push(message);
      return true;
    },
  });
  await bridge.handle({
    type: "browser.subscribe",
    threadId: "thread",
    requestId: "subscribe",
    binaryFrames: true,
  });
  expect(messages.some((message) => message.type === "browser.frame")).toBe(true);
  bridge.close();
});
