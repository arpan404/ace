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

/** A line as a browser lays it out: a 20px line box with 18px-tall glyphs inside it. */
const line = (index: number) => new DOMRect(0, index * 20 + 1, 400, 18);

/**
 * Give Range the geometry Chromium reports (jsdom has none): a box per line fragment, where the
 * break after a trailing newline has a box on its own empty line, but a bounding box that covers
 * only the glyphs, so it leaves that empty last line out.
 */
function withChromiumGeometry(boxes: () => DOMRect[], run: () => void) {
  const prototype = Range.prototype;
  const saved = (["getClientRects", "getBoundingClientRect"] as const).map(
    (name) => [name, Object.getOwnPropertyDescriptor(prototype, name)] as const,
  );
  Object.defineProperty(prototype, "getClientRects", {
    configurable: true,
    value: () => boxes(),
  });
  Object.defineProperty(prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const all = boxes();
      const glyphs = all.length > 1 ? all.slice(0, -1) : all;
      const top = Math.min(...glyphs.map((box) => box.top));
      const bottom = Math.max(...glyphs.map((box) => box.bottom));
      return new DOMRect(0, top, 400, bottom - top);
    },
  });
  try {
    run();
  } finally {
    for (const [name, native] of saved)
      if (native) Object.defineProperty(prototype, name, native);
      else Reflect.deleteProperty(prototype, name);
  }
}

test("where the browser measures text, the editor grows without collapsing between keystrokes", () => {
  let boxes = [line(0)];
  withChromiumGeometry(
    () => boxes,
    () => {
      const view = render(<Editor text="One line" measured={0} />);
      const editor = screen.getByRole("textbox");
      const observer = new MutationObserver(() => {});
      observer.observe(editor, { attributeFilter: ["style"], attributeOldValue: true });
      boxes = [line(0), line(1), line(2)];
      view.rerender(<Editor text={"One\nTwo\nThree"} measured={0} />);
      expect(editor.style.height).toBe("60px");
      boxes = [line(0), line(1), line(2), line(3), line(4)];
      view.rerender(<Editor text={"One\nTwo\nThree\nFour\nFive"} measured={0} />);
      expect(editor.style.height).toBe("100px");
      const seen = observer.takeRecords().map((record) => record.oldValue ?? "");
      observer.disconnect();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((style) => style.includes("auto"))).toBe(false);
    },
  );
});

test("a line break at the end grows the input a line at once, and removing it shrinks it back", () => {
  let boxes = [line(0), line(1)];
  withChromiumGeometry(
    () => boxes,
    () => {
      const view = render(<Editor text={"One\nTwo"} measured={0} />);
      const editor = screen.getByRole("textbox");
      expect(editor.style.height).toBe("40px");
      // ⇧↵ (or a paste ending in a newline): the caret sits alone on a new third line.
      boxes = [line(0), line(1), line(2)];
      view.rerender(<Editor text={"One\nTwo\n"} measured={0} />);
      expect(editor.style.height).toBe("60px");
      boxes = [line(0), line(1)];
      view.rerender(<Editor text={"One\nTwo"} measured={0} />);
      expect(editor.style.height).toBe("40px");
    },
  );
});

test("a draft of only line breaks shows each of its lines", () => {
  render(<Editor text={"\n\n\n"} measured={80} />);
  expect(screen.getByRole("textbox").style.height).toBe("80px");
});
