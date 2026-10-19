import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { LivePill } from "./live-pill.tsx";

test("Scroll to end says what arrived and takes the reader back", async () => {
  const onClick = vi.fn();
  render(<LivePill newItems={1200} more onClick={onClick} />);
  const pill = screen.getByRole("button", { name: "Scroll to end, 1,200+ new" });
  expect(pill.textContent).toContain("Scroll to end");
  expect(pill.textContent).toContain("1,200+ new");
  await userEvent.click(pill);
  expect(onClick).toHaveBeenCalledOnce();
});

test("a Scroll to end pill on its way out can't be reached or pressed", () => {
  render(<LivePill newItems={0} more={false} phase="exit" onClick={() => {}} />);
  expect(screen.queryByRole("button", { name: "Scroll to end" })).toBeNull();
});

test("clicking Scroll to end leaves focus on the composer, not on the hidden pill", async () => {
  const onClick = vi.fn();
  const composer = (
    <div data-composer-area>
      {/* The composer's input: contentEditable, like the real one, so it takes focus. */}
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- test stand-in for the composer input */}
      <div
        role="combobox"
        aria-label="Message"
        aria-expanded={false}
        aria-controls="message-suggestions"
        contentEditable
        tabIndex={-1}
      />
    </div>
  );
  const { rerender } = render(
    <>
      {composer}
      <LivePill newItems={0} more={false} onClick={onClick} />
    </>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
  expect(onClick).toHaveBeenCalledOnce();
  // The reader is back at the live end: the pill plays its exit, hidden from
  // assistive tech only after focus has moved on.
  rerender(
    <>
      {composer}
      <LivePill newItems={0} more={false} phase="exit" onClick={onClick} />
    </>,
  );
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Message" }));
  expect(document.activeElement).not.toBe(document.body);
  expect(screen.queryByRole("button", { name: "Scroll to end" })).toBeNull();
});
