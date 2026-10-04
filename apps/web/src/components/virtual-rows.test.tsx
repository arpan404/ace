import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { LongRows, VirtualRows, type VirtualRowsHandle } from "./virtual-rows.tsx";

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

// A 400px scroller: jsdom has no layout, so give the element its height.
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === "scroller" ? 400 : 20;
    },
  });
});
afterEach(() => {
  if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
});

test("a long list mounts only the rows near the viewport and follows scrolling", async () => {
  render(<List />);
  await act(async () => {});
  expect(screen.getByText("line 1")).toBeTruthy();
  expect(screen.queryByText("line 4000")).toBeNull();
  // A screenful (20 rows) and a few more either side, not dozens.
  expect(screen.getAllByText(/^line /).length).toBeLessThan(40);

  const scroller = screen.getByTestId("scroller");
  await act(async () => {
    scroller.scrollTop = 3_999 * 20;
    fireEvent.scroll(scroller);
  });
  expect(await screen.findByText("line 4000")).toBeTruthy();
  expect(screen.queryByText("line 1")).toBeNull();
});

function Jump() {
  const handle = useRef<VirtualRowsHandle>(null);
  return (
    <>
      <button type="button" onClick={() => handle.current?.scrollToIndex(2_999)}>
        Go to line 3000
      </button>
      <div data-testid="scroller" style={{ overflowY: "auto" }}>
        <VirtualRows
          items={lines}
          rowKey={(line) => line}
          estimate={20}
          render={(line) => <p>{line}</p>}
          handle={handle}
        />
      </div>
    </>
  );
}

test("a row far down the list can be brought into view before it is mounted", async () => {
  render(<Jump />);
  await act(async () => {});
  expect(screen.queryByText("line 3000")).toBeNull();
  // jsdom neither lays out nor scrolls; do what the browser would.
  const scroller = screen.getByTestId("scroller");
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: lines.length * 20 });
  scroller.scrollTo = ((options: ScrollToOptions) => {
    scroller.scrollTop = options.top ?? 0;
    fireEvent.scroll(scroller);
  }) as typeof scroller.scrollTo;
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Go to line 3000" })));
  expect(await screen.findByText("line 3000")).toBeTruthy();
});

/** The first `count` lines, all mounted up to 300. */
function Some(props: { count: number }) {
  return (
    <div data-testid="scroller" style={{ overflowY: "auto" }}>
      <LongRows
        items={lines.slice(0, props.count)}
        virtualAbove={300}
        rowKey={(line) => line}
        estimate={20}
        render={(line) => <p>{line}</p>}
      />
    </div>
  );
}

test("a list mounts every row until it outgrows its limit, then only those near the view", async () => {
  const { rerender } = render(<Some count={300} />);
  expect(screen.getAllByText(/^line /)).toHaveLength(300);

  rerender(<Some count={3_000} />);
  await act(async () => {});
  expect(screen.getByText("line 1")).toBeTruthy();
  expect(screen.getAllByText(/^line /).length).toBeLessThan(40);
});
