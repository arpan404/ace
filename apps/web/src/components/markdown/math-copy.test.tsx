import { fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { Markdown } from "./markdown.tsx";

function copySelection(target: Element): Record<string, string> {
  const clipboard: Record<string, string> = {};
  fireEvent.copy(target, {
    clipboardData: {
      setData: (type: string, value: string) => {
        clipboard[type] = value;
      },
    },
  });
  return clipboard;
}

test("copying prose with rendered math copies the TeX the agent wrote", async () => {
  const text = "Two-sum takes \\(O(n)\\) time.\n\n$$x^2$$\n\nDone.";
  const view = render(<Markdown text={text} />);
  await waitFor(() => expect(view.container.querySelectorAll("math").length).toBe(2));
  const root = view.container.firstElementChild;
  if (!root) throw new Error("no prose root");
  document.getSelection()?.selectAllChildren(root);
  expect(copySelection(root)["text/plain"]).toBe(
    "Two-sum takes \\(O(n)\\) time.\n\n$$x^2$$\n\nDone.",
  );
  view.unmount();
});

test("a selection that starts inside a formula copies the whole formula", async () => {
  const view = render(<Markdown text={"Sorting is \\(O(n\\log n)\\) here."} />);
  await waitFor(() => expect(view.container.querySelector("math")).not.toBeNull());
  const glyph = view.container.querySelector(".katex-html");
  const paragraph = view.container.querySelector("p");
  if (!glyph?.firstChild || !paragraph?.lastChild) throw new Error("no rendered formula");
  const range = document.createRange();
  range.setStart(glyph.firstChild, 0);
  range.setEnd(paragraph.lastChild, paragraph.lastChild.textContent?.length ?? 0);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  expect(copySelection(paragraph)["text/plain"]).toBe("\\(O(n\\log n)\\) here.");
  view.unmount();
});

test("copying prose without math keeps the browser's own copy", async () => {
  const view = render(<Markdown text={"Plain words only."} />);
  const paragraph = await waitFor(() => {
    const found = view.container.querySelector("p");
    if (!found) throw new Error("not rendered");
    return found;
  });
  document.getSelection()?.selectAllChildren(paragraph);
  expect(copySelection(paragraph)).toEqual({});
  view.unmount();
});
