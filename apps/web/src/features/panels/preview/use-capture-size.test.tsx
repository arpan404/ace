import { render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useCaptureSize } from "./use-capture-size.ts";
import type { PreviewSource } from "../sources.ts";
import { daemonPreview } from "./daemon-preview.ts";
import { FakeDaemon } from "@ace/fake-daemon";
import { fakeClient } from "@/test/harness.tsx";

function Viewer({ source }: { source: PreviewSource }) {
  const pane = useRef<HTMLDivElement>(null);
  useCaptureSize(source, "thread", pane);
  return <div ref={pane} />;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("a viewer keeps DPR-sized capture after reconnect without taking control or resizing the page", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.stubGlobal("devicePixelRatio", 2);
  const requests: unknown[] = [];
  const daemon = new FakeDaemon({ clock: () => 1 });
  const client = fakeClient(daemon);
  await client.start();
  // The transport is the boundary; the real PreviewSource builds the wire request.
  vi.spyOn(client, "request").mockImplementation(async (request) => {
    requests.push(request);
    return { type: "browser.result", requestId: "test", ok: true, result: null };
  });
  const source = daemonPreview(client);
  const stop = source.watch("thread");
  const view = render(<Viewer source={source} />);
  await waitFor(() =>
    expect(
      requests.filter(
        (request) =>
          typeof request === "object" &&
          request !== null &&
          "type" in request &&
          request.type === "browser.capture",
      ),
    ).toEqual([
      {
        type: "browser.capture",
        threadId: "thread",
        viewport: { width: 900, height: 600, devicePixelRatio: 2 },
      },
    ]),
  );
  requests.length = 0;
  daemon.disconnectAll();
  await waitFor(() =>
    expect(requests).toContainEqual({
      type: "browser.capture",
      threadId: "thread",
      viewport: { width: 900, height: 600, devicePixelRatio: 2 },
    }),
  );
  expect(
    requests.some(
      (request) =>
        typeof request === "object" &&
        request !== null &&
        "type" in request &&
        (request.type === "browser.takeover" || request.type === "browser.execute"),
    ),
  ).toBe(false);
  view.unmount();
  stop();
  vi.unstubAllGlobals();
});
