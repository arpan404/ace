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

function Rail({ single = false }: { single?: boolean }) {
  const [selected, setSelected] = useState("");
  return (
    <>
      <ConversationRail
        markers={single ? markers.slice(0, 1) : markers}
        height={400}
        onJump={setSelected}
        renderPreview={preview}
      />
      <output aria-label="Selected turn">{selected}</output>
    </>
  );
}

test("hovering a tick never pops a preview, and a click jumps to its turn", async () => {
  render(<Rail />);
  const user = userEvent.setup();
  const target = screen.getByRole("button", { name: "Fix retry" });
  await user.hover(target);
  expect(screen.queryByText(/Preview/)).toBeNull();
  await user.click(target);
  expect(screen.getByLabelText("Selected turn").textContent).toBe("second");
  expect(screen.queryByText(/Preview/)).toBeNull();
});

test("keyboard traversal has one tab stop and Enter jumps the focused turn", async () => {
  render(<Rail />);
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

test("no turn is emphasized: every tick shares the same size and color at rest", () => {
  render(<Rail />);
  const buttons = screen.getAllByRole("button");
  expect(buttons).toHaveLength(3);
  for (const button of buttons) expect(button.getAttribute("aria-current")).toBeNull();
  const ticks = buttons.map((button) => button.querySelector("span"));
  expect(ticks.every(Boolean)).toBe(true);
  const classes = ticks.map((tick) => tick?.getAttribute("class"));
  expect(new Set(classes).size).toBe(1);
  expect(classes[0]).toContain("bg-foreground/30");
  expect(classes[0]).toContain("scale-x-[0.45]");
});

test("a one-turn conversation does not add an outline", () => {
  render(<Rail single />);
  expect(screen.queryByRole("navigation", { name: "Conversation turns" })).toBeNull();
});

test("keyboard focus previews one turn at a time and Escape or leaving closes it", async () => {
  render(<Rail />);
  const user = userEvent.setup();
  await user.tab();
  expect(screen.getByText("Preview first")).toBeTruthy();
  await user.keyboard("{End}");
  expect(screen.getByText("Preview third")).toBeTruthy();
  expect(screen.queryByText("Preview first")).toBeNull();
  await user.keyboard("{Escape}");
  expect(screen.queryByText(/Preview/)).toBeNull();
  await user.keyboard("{Home}");
  expect(screen.getByText("Preview first")).toBeTruthy();
  await user.tab();
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
