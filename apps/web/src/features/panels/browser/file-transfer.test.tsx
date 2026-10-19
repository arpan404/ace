import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { saveWay, savedType } from "./save-to-device.ts";
import { dropRefusal, type DropPoint } from "./use-browser-features.ts";
import { useFileDrop } from "./use-file-drop.tsx";

function Page(props: { dropped: { files: File[]; at: DropPoint }[] }) {
  const drop = useFileDrop(
    (event) => ({ x: event.clientX * 2, y: event.clientY * 2 }),
    (files, at) => props.dropped.push({ files, at }),
  );
  return (
    <div data-testid="page" {...drop.handlers}>
      {drop.indicator}
    </div>
  );
}

const transfer = (types: string[], files: File[]) => ({ types, files, dropEffect: "none" });

test("files dropped on the live page go to it at the page's point, with the keys held", () => {
  const dropped: { files: File[]; at: DropPoint }[] = [];
  render(<Page dropped={dropped} />);
  const page = screen.getByTestId("page");
  const file = new File(["hello"], "notes.txt", { type: "text/plain" });
  const over = createEvent.dragOver(page, { dataTransfer: transfer(["Files"], [file]) });
  fireEvent(page, over);
  // Taking the drag over is what lets the device's browser drop it here at all.
  expect(over.defaultPrevented).toBe(true);
  // jsdom has no DragEvent: a mouse event named "drop" carries the pointer and keys.
  const drop = new MouseEvent("drop", {
    bubbles: true,
    cancelable: true,
    clientX: 30,
    clientY: 40,
    shiftKey: true,
  });
  Object.defineProperty(drop, "dataTransfer", { value: transfer(["Files"], [file]) });
  fireEvent(page, drop);
  expect(drop.defaultPrevented).toBe(true);
  expect(dropped).toEqual([{ files: [file], at: { x: 60, y: 80, modifiers: 8 } }]);
});

test("dragged text or an ace tab is left to whatever else takes it", () => {
  const dropped: { files: File[]; at: DropPoint }[] = [];
  render(<Page dropped={dropped} />);
  const page = screen.getByTestId("page");
  const over = createEvent.dragOver(page, { dataTransfer: transfer(["text/plain"], []) });
  fireEvent(page, over);
  expect(over.defaultPrevented).toBe(false);
  fireEvent.drop(page, { dataTransfer: transfer(["text/plain"], []) });
  expect(dropped).toEqual([]);
});

test("too many files, or one over the limit, are refused before anything uploads", () => {
  expect(dropRefusal([{ size: 10 }])).toBeUndefined();
  expect(dropRefusal(Array.from({ length: 17 }, () => ({ size: 1 })))).toMatch(/16 files/);
  expect(dropRefusal([{ size: 33 * 1024 * 1024 }])).toMatch(/32 MB/);
});

test("a phone shares a saved download, so it can go to Files; a computer downloads it", () => {
  expect(saveWay({ touch: true, shareFiles: true })).toBe("share");
  expect(saveWay({ touch: true, shareFiles: false })).toBe("download");
  expect(saveWay({ touch: false, shareFiles: true })).toBe("download");
});

test("an executable is saved as plain bytes, never as something the device would run", () => {
  expect(
    savedType({ filename: "setup.sh", mimeType: "application/x-sh", flags: ["executable"] }),
  ).toBe("application/octet-stream");
  expect(savedType({ filename: "report.pdf", mimeType: "application/pdf", flags: [] })).toBe(
    "application/pdf",
  );
});
