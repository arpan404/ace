import { expect, test, vi } from "vitest";
import {
  BrowserAnnotationCapture,
  BrowserAnnotationEvent,
  DeviceId,
  ClientMessage,
  ServerMessage,
} from "@ace/protocol";
import { FakeDaemon } from "./daemon.ts";

function fixture() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({
    id: "thread",
    workspaceId: "workspace",
    title: "Annotate",
    provider: "codex",
    access: "auto-review",
  });
  daemon.browser.drive("thread", { url: "about:blank" });
  let request = 0;
  const peer = (device: string) => {
    const messages: ServerMessage[] = [];
    const connection = daemon.connect({
      send: (text) => messages.push(ServerMessage.parse(JSON.parse(text))),
      close() {},
    });
    const send = (message: ClientMessage) => connection.receive(JSON.stringify(message));
    send({
      type: "hello",
      deviceId: DeviceId.parse(device),
      token: "fake-token",
      protocolVersion: 1,
    });
    const call = async (message: Record<string, unknown>) => {
      const requestId = `r${++request}`;
      send(ClientMessage.parse({ requestId, threadId: "thread", ...message }));
      return vi.waitFor(() => {
        const result = messages.find(
          (candidate) => candidate.type === "browser.result" && candidate.requestId === requestId,
        );
        if (result?.type !== "browser.result") throw new Error("pending");
        return result;
      });
    };
    const events = () =>
      messages.flatMap((message) =>
        message.type === "browser.annotation" ? [BrowserAnnotationEvent.parse(message.event)] : [],
      );
    return { call, events };
  };
  return { daemon, peer };
}

test("the fixture's annotate mode reports to its owner only, scripts pins and ends on handback", async () => {
  const { daemon, peer } = fixture();
  const person = peer("person");
  const viewer = peer("viewer");
  await viewer.call({ type: "browser.subscribe" });
  expect((await person.call({ type: "browser.takeover" })).ok).toBe(true);
  const start = { type: "browser.execute", command: { action: "annotate", operation: "start" } };
  expect((await viewer.call(start)).ok).toBe(false);
  const started = await person.call(start);
  expect(started).toMatchObject({ ok: true, result: { documentId: expect.any(String) } });
  expect(person.events()).toMatchObject([{ kind: "ready" }]);
  expect(daemon.browser.view("thread")?.annotation).toBeDefined();
  daemon.browser.annotations.pin("thread", { comment: "Bigger heading", tag: "h1" });
  expect(person.events().at(-1)).toMatchObject({
    kind: "saved",
    annotation: { number: 1, comment: "Bigger heading", element: { tag: "h1" } },
  });
  const capture = await person.call({
    type: "browser.execute",
    command: { action: "annotate_capture", target: { kind: "page" } },
  });
  expect(BrowserAnnotationCapture.parse(capture.result)).toMatchObject({ mimeType: "image/png" });
  await person.call({ type: "browser.handback" });
  expect(person.events().at(-1)).toEqual({ kind: "ended", reason: "lease" });
  expect(viewer.events()).toEqual([]);
  expect(daemon.browser.view("thread")?.annotation).toBeUndefined();
});
