import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ResizeHandle } from "./resize-handle.tsx";

test.each(["pointerCancel", "lostPointerCapture"] as const)(
  "%s finishes a resize once and leaves the next gesture usable",
  (event) => {
    const end = vi.fn();
    const resize = vi.fn();
    render(
      <ResizeHandle
        label="Resize pane"
        edge="left"
        size={500}
        min={360}
        max={800}
        onResize={resize}
        onResizeEnd={end}
      />,
    );
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 9, clientX: 700 });
    fireEvent.pointerMove(handle, { pointerId: 9, clientX: 100 });
    fireEvent.pointerCancel(handle, { pointerId: 9 });
    expect(end).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 460 });
    fireEvent[event](handle, { pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(end).toHaveBeenCalledExactlyOnceWith(540);
    expect(handle.hasAttribute("data-dragging")).toBe(false);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 480 });
    fireEvent.pointerUp(handle, { pointerId: 2 });
    expect(end).toHaveBeenLastCalledWith(520);
  },
);
