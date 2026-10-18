import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { expect, test } from "vitest";
import { useAutosize } from "./use-autosize.ts";

function Editor({ text, measured }: { text: string; measured: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useAutosize(ref, text, 600);
  return (
    <div
      role="textbox"
      ref={(el) => {
        ref.current = el;
        if (el) Object.defineProperty(el, "scrollHeight", { configurable: true, value: measured });
      }}
    >
      {text}
    </div>
  );
}

test("empty, short and cleared messages reserve two lines while longer drafts grow and scroll", () => {
  const view = render(<Editor text="" measured={20} />);
  const editor = screen.getByRole("textbox");
  expect(editor.style.height).toBe("40px");
  view.rerender(<Editor text="One line" measured={20} />);
  expect(editor.style.height).toBe("40px");
  view.rerender(<Editor text={"First\nSecond\nThird"} measured={60} />);
  expect(editor.style.height).toBe("60px");
  view.rerender(<Editor text="Long draft" measured={400} />);
  act(() => window.dispatchEvent(new Event("resize")));
  expect(editor.style.height).toBe("140px");
  expect(editor.textContent).toBe("Long draft");
  view.rerender(<Editor text="" measured={20} />);
  expect(editor.style.height).toBe("40px");
});

test("where the browser measures text, the editor grows without collapsing between keystrokes", () => {
  let contentHeight = 19;
  // jsdom has no Range geometry; a browser's text box is what this path reads.
  const native = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(0, 0, 400, contentHeight),
  });
  try {
    const view = render(<Editor text="One line" measured={0} />);
    const editor = screen.getByRole("textbox");
    const observer = new MutationObserver(() => {});
    observer.observe(editor, { attributeFilter: ["style"], attributeOldValue: true });
    contentHeight = 59;
    view.rerender(<Editor text={"One\nTwo\nThree"} measured={0} />);
    expect(editor.style.height).toBe("60px");
    contentHeight = 101;
    view.rerender(<Editor text={"One\nTwo\nThree\nFour\nFive"} measured={0} />);
    expect(editor.style.height).toBe("100px");
    const seen = observer.takeRecords().map((record) => record.oldValue ?? "");
    observer.disconnect();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((style) => style.includes("auto"))).toBe(false);
  } finally {
    if (native) Object.defineProperty(Range.prototype, "getBoundingClientRect", native);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  }
});
