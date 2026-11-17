import { expect, it } from "vitest";
import { CdpConnection } from "./cdp-connection.ts";

function connection() {
  return new CdpConnection({
    write: () => {},
    schedule: (work, milliseconds) => {
      const timer = setTimeout(work, milliseconds);
      return () => clearTimeout(timer);
    },
    hung: () => {},
  });
}

it("a page event listener that throws neither escapes the pipe nor keeps the event from the others", () => {
  const cdp = connection();
  const page = cdp.session("page-1");
  const heard: unknown[] = [];
  page.on("Page.javascriptDialogOpening", () => {
    throw new Error("dialog did not parse");
  });
  page.on("Page.javascriptDialogOpening", (params) => heard.push(params));
  const event = JSON.stringify({
    method: "Page.javascriptDialogOpening",
    params: { type: "alert", message: "hi" },
    sessionId: "page-1",
  });
  expect(() => cdp.receive(event)).not.toThrow();
  expect(() => cdp.receive(event)).not.toThrow();
  expect(heard).toEqual([
    { type: "alert", message: "hi" },
    { type: "alert", message: "hi" },
  ]);
});
