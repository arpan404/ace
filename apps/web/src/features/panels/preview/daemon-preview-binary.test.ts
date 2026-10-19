import { FakeDaemon, ScenarioPlayer, failingSubagent } from "@ace/fake-daemon";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { fakeClient } from "@/test/fake-client.ts";
import { daemonPreview } from "./daemon-preview.ts";
import { streamingClient } from "./stream-test-support.ts";

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
