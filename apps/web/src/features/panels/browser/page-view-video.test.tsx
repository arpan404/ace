import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { BrowserView, ForwardedInput, PreviewSource, ScreenFrame } from "../sources.ts";
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

/** A video picture: 390 × 800 CSS pixels, decoded at 3x. */
function videoFrame(drawn: HTMLCanvasElement[]): ScreenFrame {
  return {
    sequence: 5,
    src: "",
    width: 390,
    height: 800,
    video: {
      codedWidth: 1170,
      codedHeight: 2400,
      draw(canvas) {
        drawn.push(canvas);
        return true;
      },
    },
  };
}

test("a video frame is drawn on a canvas at its device pixels, not scaled up from CSS size", () => {
  const drawn: HTMLCanvasElement[] = [];
  render(
    <PageView
      source={recordingSource([])}
      threadId="thread-1"
      view={view}
      tab={undefined}
      frame={videoFrame(drawn)}
      interactive
      fit
    />,
  );
  const picture = screen.getByRole("img", { name: "Live view of https://example.com/" });
  expect(picture.tagName).toBe("CANVAS");
  expect(drawn).toEqual([picture]);
  expect((picture as HTMLCanvasElement).width).toBe(1170);
  expect((picture as HTMLCanvasElement).height).toBe(2400);
});

test("a click on a video picture reaches the page in its CSS pixels, through the drawn box", () => {
  const sent: ForwardedInput[] = [];
  render(
    <PageView
      source={recordingSource(sent)}
      threadId="thread-1"
      view={view}
      tab={undefined}
      frame={videoFrame([])}
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
