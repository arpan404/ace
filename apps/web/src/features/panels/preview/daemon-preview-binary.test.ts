import { FakeDaemon, ScenarioPlayer, failingSubagent } from "@ace/fake-daemon";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ClientApi, StreamMessage } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { fakeClient } from "@/test/fake-client.ts";
import { daemonPreview } from "./daemon-preview.ts";

/**
 * The in-memory client, plus binary stream messages the test hands in, with the requests and
 * one-way messages it sends recorded.
 */
function streamingClient(client: ClientApi) {
  const listeners = new Set<(message: StreamMessage) => void>();
  const requests: unknown[] = [];
  const sent: unknown[] = [];
  const api = new Proxy(client, {
    get(target, key) {
      if (key === "onStream")
        return (listener: (message: StreamMessage) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        };
      if (key === "request")
        return (input: Parameters<ClientApi["request"]>[0], options?: object) => {
          requests.push(input);
          return target.request(input, options);
        };
      if (key === "send")
        return (message: Parameters<ClientApi["send"]>[0]) => {
          sent.push(message);
          target.send(message);
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    api,
    requests,
    sent,
    stream(message: StreamMessage) {
      for (const listener of listeners) listener(message);
    },
  };
}

test("a phone asks for binary frames with its pane's size, and shows and ACKs a frame's bytes", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  daemon.browser.drive("thread-settings", { url: "http://localhost:5173" });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const wire = streamingClient(client);
  const preview = daemonPreview(wire.api, {
    schedule: () => () => {},
    visibility: { visible: () => true, watch: () => () => {} },
    decode: (picture) =>
      Promise.resolve({
        src: typeof picture === "string" ? `json:${picture}` : `bytes:${[...picture].join(",")}`,
        release() {},
      }),
  });
  // The pane reports its size before the view watches the thread.
  preview.capture?.("thread-settings", 390, 800, 3);
  const stop = preview.watch("thread-settings");
  await preview.open("thread-settings", failingSubagent().thread.workspaceId);
  await waitFor(() =>
    expect(wire.requests).toContainEqual(
      expect.objectContaining({
        type: "browser.subscribe",
        binaryFrames: true,
        viewport: expect.objectContaining({ width: 390, height: 800, devicePixelRatio: 3 }),
      }),
    ),
  );

  wire.stream({
    kind: "browser.frame",
    threadId: ThreadId.parse("thread-settings"),
    frame: {
      sequence: 99,
      timestamp: 1000,
      width: 390,
      height: 800,
      bytes: new Uint8Array([255, 216, 255, 217]),
    },
  });
  await waitFor(() => expect(preview.frame("thread-settings")?.src).toBe("bytes:255,216,255,217"));
  expect(preview.frame("thread-settings")).toMatchObject({ width: 390, height: 800 });
  expect(wire.sent).toContainEqual(expect.objectContaining({ type: "browser.ack", sequence: 99 }));
  stop();
  preview.dispose();
});

test("a touch pane's screen density goes with its resize, alongside its touch layout", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const wire = streamingClient(client);
  const preview = daemonPreview(wire.api, {
    schedule: () => () => {},
    visibility: { visible: () => true, watch: () => () => {} },
  });
  preview.resize("thread-settings", 390, 800, true, 3);
  await waitFor(() =>
    expect(wire.requests).toContainEqual(
      expect.objectContaining({
        type: "browser.execute",
        command: {
          action: "resize",
          width: 390,
          height: 800,
          touch: true,
          devicePixelRatio: 3,
        },
      }),
    ),
  );
  preview.dispose();
});
