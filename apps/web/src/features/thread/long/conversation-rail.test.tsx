import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ConversationRail } from "./conversation-rail.tsx";

const markers = [
  { id: "first", ordinal: 1, label: "Audit login" },
  { id: "second", ordinal: 2, label: "Fix retry" },
  { id: "third", ordinal: 3, label: "Run tests" },
];

const preview = (id: string) => <p>Preview {id}</p>;

function Rail({ currentId, single = false }: { currentId?: string; single?: boolean }) {
  const [selected, setSelected] = useState("");
  return (
    <>
      <ConversationRail
        markers={single ? markers.slice(0, 1) : markers}
        height={400}
        {...(currentId ? { currentId } : {})}
        onJump={setSelected}
        renderPreview={preview}
      />
      <output aria-label="Selected turn">{selected}</output>
    </>
  );
}

test("only the hovered turn mounts its preview, while click delegates the jump", async () => {
  render(<Rail currentId="second" />);
  expect(screen.queryByText(/Preview/)).toBeNull();
  const user = userEvent.setup();
  const target = screen.getByRole("button", { name: "Fix retry" });
  expect(target.getAttribute("aria-current")).toBe("location");
  await user.hover(target);
  await screen.findByText("Preview second");
  expect(screen.queryByText("Preview first")).toBeNull();
  expect(screen.queryByText("Preview third")).toBeNull();
  await user.click(target);
  expect(screen.getByLabelText("Selected turn").textContent).toBe("second");
});

test("keyboard traversal has one tab stop and Enter jumps the focused turn", async () => {
  render(<Rail currentId="first" />);
  const user = userEvent.setup();
  await user.tab();
  const first = screen.getByRole("button", { name: "Audit login" });
  expect(document.activeElement).toBe(first);
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Run tests" }));
  await user.keyboard("{ArrowUp}{Enter}");
  expect(screen.getByLabelText("Selected turn").textContent).toBe("second");
  await user.keyboard("{Home}");
  expect(document.activeElement).toBe(first);
});

test("a one-turn conversation does not add an outline", () => {
  render(<Rail single />);
  expect(screen.queryByRole("navigation", { name: "Conversation turns" })).toBeNull();
});

test("moving along the rail previews each turn at once, one preview at a time", async () => {
  render(<Rail />);
  const user = userEvent.setup();
  await user.hover(screen.getByRole("button", { name: "Audit login" }));
  expect(screen.getByText("Preview first")).toBeTruthy();
  await user.hover(screen.getByRole("button", { name: "Run tests" }));
  expect(screen.getByText("Preview third")).toBeTruthy();
  expect(screen.queryByText("Preview first")).toBeNull();
  await user.unhover(screen.getByRole("navigation", { name: "Conversation turns" }));
  expect(screen.queryByText(/Preview/)).toBeNull();
});

test("a rail of many turns closes up to fit its room instead of scrolling", () => {
  const many = Array.from({ length: 120 }, (_, index) => ({
    id: String(index + 1),
    ordinal: index + 1,
    label: `Turn ${index + 1}`,
  }));
  render(
    <ConversationRail markers={many} height={300} onJump={() => {}} renderPreview={preview} />,
  );
  const rail = screen.getByRole("navigation", { name: "Conversation turns" });
  expect(rail.style.height).toBe("300px");
  expect(rail.style.overflowY).toBe("");
  const last = screen.getByRole("button", { name: "Turn 120" });
  expect(last.style.top).toBe("100%");
});
