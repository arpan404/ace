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
