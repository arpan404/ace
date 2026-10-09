import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ConversationRail } from "./conversation-rail.tsx";

const markers = [
  { id: "first", ordinal: 1, label: "Audit login" },
  { id: "second", ordinal: 2, label: "Fix retry" },
  { id: "third", ordinal: 3, label: "Run tests" },
];

test("only the hovered turn mounts its preview, while click delegates the jump", async () => {
  const preview = vi.fn((id: string) => <p>Preview {id}</p>);
  const jump = vi.fn();
  render(
    <ConversationRail markers={markers} currentId="second" onJump={jump} renderPreview={preview} />,
  );
  expect(preview).not.toHaveBeenCalled();
  const user = userEvent.setup();
  const target = screen.getByRole("button", { name: "Turn 2: Fix retry" });
  expect(target.getAttribute("aria-current")).toBe("location");
  await user.hover(target);
  await screen.findByText("Preview second");
  expect(preview.mock.calls.every(([id]) => id === "second")).toBe(true);
  await user.click(target);
  expect(jump).toHaveBeenCalledWith("second");
});

test("keyboard traversal has one tab stop and Enter jumps the focused turn", async () => {
  const jump = vi.fn();
  render(
    <ConversationRail
      markers={markers}
      currentId="first"
      onJump={jump}
      renderPreview={(id) => <p>{id}</p>}
    />,
  );
  const user = userEvent.setup();
  await user.tab();
  const first = screen.getByRole("button", { name: "Turn 1: Audit login" });
  expect(document.activeElement).toBe(first);
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Turn 3: Run tests" }));
  await user.keyboard("{ArrowUp}{Enter}");
  expect(jump).toHaveBeenCalledWith("second");
  await user.keyboard("{Home}");
  expect(document.activeElement).toBe(first);
  await waitFor(() =>
    expect(screen.getAllByRole("button").filter((button) => button.tabIndex === 0)).toHaveLength(1),
  );
});

test("a one-turn conversation does not add an outline", () => {
  render(
    <ConversationRail markers={markers.slice(0, 1)} onJump={vi.fn()} renderPreview={vi.fn()} />,
  );
  expect(screen.queryByRole("navigation", { name: "Conversation turns" })).toBeNull();
});
