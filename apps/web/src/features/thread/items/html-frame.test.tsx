import { render, screen, waitFor, act } from "@testing-library/react";
import { expect, test } from "vitest";
import { HtmlFrame } from "./html-frame.tsx";

const send = (data: unknown, source: MessageEventSource | null, origin = "null") =>
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
  });

test("only a bounded height from this visualization's opaque frame resizes its row", async () => {
  render(
    <HtmlFrame
      html="<!doctype html><html><body>Chart</body></html>"
      title="Chart"
      theme={{}}
      height={600}
    />,
  );
  const frame = screen.getByTitle<HTMLIFrameElement>("Chart");

  send({ type: "ace.html.height", height: 500 }, window);
  send({ type: "ace.html.height", height: Infinity }, frame.contentWindow);
  send({ type: "ace.html.height", height: 500, token: "unexpected" }, frame.contentWindow);
  send({ type: "ace.html.height", height: 500 }, frame.contentWindow, location.origin);
  expect(frame.style.height).toBe("320px");
  send({ type: "ace.html.height", height: 500 }, frame.contentWindow);
  await waitFor(() => expect(frame.style.height).toBe("500px"));
  send({ type: "ace.html.height", height: 9000 }, frame.contentWindow);
  await waitFor(() => expect(frame.style.height).toBe("600px"));
});
