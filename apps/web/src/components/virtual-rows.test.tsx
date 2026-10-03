import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { VirtualRows } from "./virtual-rows.tsx";

const lines = Array.from({ length: 5_000 }, (_, n) => `line ${n + 1}`);

function List() {
  return (
    <div data-testid="scroller" style={{ overflowY: "auto" }}>
      <VirtualRows
        items={lines}
        rowKey={(line) => line}
        estimate={20}
        render={(line) => <p>{line}</p>}
      />
    </div>
  );
}

test("a long list mounts only the rows near the viewport and follows scrolling", async () => {
  // A 400px scroller: jsdom has no layout, so give the element its height.
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === "scroller" ? 400 : 20;
    },
  });
  try {
    render(<List />);
    await act(async () => {});
    expect(screen.getByText("line 1")).toBeTruthy();
    expect(screen.queryByText("line 4000")).toBeNull();
    expect(screen.getAllByText(/^line /).length).toBeLessThan(100);

    const scroller = screen.getByTestId("scroller");
    await act(async () => {
      scroller.scrollTop = 3_999 * 20;
      fireEvent.scroll(scroller);
    });
    expect(await screen.findByText("line 4000")).toBeTruthy();
    expect(screen.queryByText("line 1")).toBeNull();
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
  }
});
