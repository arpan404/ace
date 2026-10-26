import { render, screen, waitFor, act } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import { HtmlFrame } from "./html-frame.tsx";

/** The frame as the transcript holds it: the measured height lives with the caller. */
function Frame() {
  const [measured, setMeasured] = useState<number>();
  return (
    <HtmlFrame
      html="<!doctype html><html><body>Chart</body></html>"
      mode="static"
      title="Chart"
      theme={{}}
      initialHeight={160}
      fill={false}
      webview={false}
      measured={measured}
      settled={measured !== undefined}
      onHeight={setMeasured}
    />
  );
}

const send = (data: unknown, source: MessageEventSource | null, origin = "null") =>
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
  });

test("a tall visualization takes its whole height, set only by its own opaque frame", async () => {
  render(<Frame />);
  const frame = screen.getByTitle<HTMLIFrameElement>("Chart");

  send({ type: "ace.html.height", height: 500 }, window);
  send({ type: "ace.html.height", height: Infinity }, frame.contentWindow);
  send({ type: "ace.html.height", height: 500, token: "unexpected" }, frame.contentWindow);
  send({ type: "ace.html.height", height: 500 }, frame.contentWindow, location.origin);
  expect(frame.style.height).toBe("160px");
  send({ type: "ace.html.height", height: 500 }, frame.contentWindow);
  await waitFor(() => expect(frame.style.height).toBe("500px"));
  send({ type: "ace.html.height", height: 9000 }, frame.contentWindow);
  await waitFor(() => expect(frame.style.height).toBe("9000px"));
});
