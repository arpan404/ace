import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { LivePill } from "./live-pill.tsx";

test("Jump to live says what arrived and that following is paused, and takes the reader back", async () => {
  const onClick = vi.fn();
  render(<LivePill newItems={1200} more paused onClick={onClick} />);
  const pill = screen.getByRole("button", { name: "Jump to live, 1,200+ new" });
  expect(pill.textContent).toContain("Following paused");
  await userEvent.click(pill);
  expect(onClick).toHaveBeenCalledOnce();
});

test("a Jump to live pill on its way out can't be reached or pressed", () => {
  render(<LivePill newItems={0} more={false} paused={false} phase="exit" onClick={() => {}} />);
  expect(screen.queryByRole("button", { name: "Jump to live" })).toBeNull();
});
