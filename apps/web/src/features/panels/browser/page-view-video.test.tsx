import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { BrowserView, ForwardedInput, PreviewSource, ScreenFrame } from "../sources.ts";
import { browserVideo } from "@/test/browser-video.ts";
import { PageView } from "./page-view.tsx";

/** A source that records the person's input and has no page state; nothing else is used. */
function recordingSource(sent: ForwardedInput[]): PreviewSource {
  return new Proxy({} as PreviewSource, {
    get(_, key) {
      if (key === "input")
        return (_thread: string, input: ForwardedInput) => {
          sent.push(input);
          return Promise.resolve();
        };
      if (key === "subscribe") return () => () => {};
      return () => undefined;
    },
  });
}

const view: BrowserView = {
  threadId: "thread-1",
  url: "https://example.com/",
  closed: false,
};

/** A live picture: 390 × 800 CSS pixels, decoded at 3x; `next` brings a newer picture. */
function livePicture() {
  const listeners = new Set<() => void>();
  let sequence = 5;
  const draws: { sequence: number; width: number; height: number }[] = [];
  const frame: ScreenFrame = {
    get sequence() {
      return sequence;
    },
    width: 390,
    height: 800,
    codedWidth: 1170,
    codedHeight: 2400,
    draw(_context, width, height) {
      draws.push({ sequence, width, height });
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    frame,
    draws,
    next() {
      sequence++;
      for (const listener of listeners) listener();
    },
  };
}

const animationFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

test("a live picture is drawn on a canvas at its device pixels, not scaled up from CSS size", () => {
  browserVideo();
  const live = livePicture();
  render(
    <PageView
      source={recordingSource([])}
      threadId="thread-1"
      view={view}
      tab={undefined}
      frame={live.frame}
      interactive
      fit
    />,
  );
  const picture = screen.getByRole("img", { name: "Live view of https://example.com/" });
  expect(picture.tagName).toBe("CANVAS");
  expect((picture as HTMLCanvasElement).width).toBe(1170);
  expect((picture as HTMLCanvasElement).height).toBe(2400);
  expect(live.draws).toEqual([{ sequence: 5, width: 1170, height: 2400 }]);
});

test("newer pictures are drawn on the next animation frame, only the newest of them", async () => {
  browserVideo();
  const live = livePicture();
  render(
    <PageView
      source={recordingSource([])}
      threadId="thread-1"
      view={view}
      tab={undefined}
      frame={live.frame}
      interactive
      fit
    />,
  );
  live.next();
  live.next();
  live.next();
  expect(live.draws.map((draw) => draw.sequence)).toEqual([5]);
  await animationFrame();
  expect(live.draws.map((draw) => draw.sequence)).toEqual([5, 8]);
});

test("a click on a video picture reaches the page in its CSS pixels, through the drawn box", () => {
  const sent: ForwardedInput[] = [];
  render(
    <PageView
      source={recordingSource(sent)}
      threadId="thread-1"
      view={view}
      tab={undefined}
      frame={livePicture().frame}
      interactive
      fit
    />,
  );
  const picture = screen.getByRole("img", { name: "Live view of https://example.com/" });
  // The canvas is drawn at half its CSS size, 20 px in from the pane's corner.
  picture.getBoundingClientRect = () => new DOMRect(20, 10, 195, 400);
  const page = screen.getByRole("application");
  fireEvent.mouseDown(page, { clientX: 20 + 50, clientY: 10 + 100, button: 0, detail: 1 });
  expect(sent).toContainEqual(
    expect.objectContaining({ kind: "mouse", event: "mousePressed", x: 100, y: 200 }),
  );
});
