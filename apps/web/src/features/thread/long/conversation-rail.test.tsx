import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
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

/** The classes that set a tick's size; emphasis must never touch them. */
function sizeOf(button: HTMLElement): string[] {
  const tick = button.querySelector("span");
  return (tick?.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter((name) => /^(w-|h-|scale|size-|min-|max-|ml-|mr-|mx-)/.test(name));
}

function colourOf(button: HTMLElement): string | undefined {
  const tick = button.querySelector("span");
  return (tick?.getAttribute("class") ?? "").split(/\s+/).find((name) => name.startsWith("bg-"));
}

test("the reader's turn draws brighter than the rest but the same size", () => {
  render(
    <ConversationRail
      markers={markers}
      height={400}
      current="second"
      onJump={() => {}}
      renderPreview={preview}
    />,
  );
  const [first, second, third] = screen.getAllByRole("button");
  if (!first || !second || !third) throw new Error("expected three ticks");
  expect(second.getAttribute("aria-current")).toBe("location");
  expect(first.getAttribute("aria-current")).toBeNull();
  expect(third.getAttribute("aria-current")).toBeNull();
  expect(colourOf(second)).not.toBe(colourOf(first));
  expect(colourOf(first)).toBe(colourOf(third));
  expect(sizeOf(second)).toEqual(sizeOf(first));
  expect(sizeOf(first).length).toBeGreaterThan(0);
});

test("hovering a tick brightens it without resizing any tick", async () => {
  render(<Rail />);
  const user = userEvent.setup();
  const buttons = screen.getAllByRole("button");
  const before = buttons.map(sizeOf);
  const resting = buttons.map(colourOf);
  const target = screen.getByRole("button", { name: "Fix retry" });
  await user.hover(target);
  expect(colourOf(target)).not.toBe(resting[1]);
  expect(buttons.map(sizeOf)).toEqual(before);
});

/** A transcript whose scroll position and clock the test moves by hand. */
function fakeTranscript() {
  const element = document.createElement("div");
  let top = 0;
  Object.defineProperty(element, "scrollTop", { get: () => top });
  let clock = 0;
  let pending: { at: number; run: () => void } | undefined;
  const time = {
    now: () => clock,
    after(ms: number, run: () => void) {
      const timer = { at: clock + ms, run };
      pending = timer;
      return () => {
        if (pending === timer) pending = undefined;
      };
    },
  };
  return {
    ref: { current: element },
    time,
    scrollTo(position: number, at: number) {
      clock = at;
      top = position;
      act(() => void element.dispatchEvent(new Event("scroll")));
    },
    wait(ms: number) {
      clock += ms;
      const timer = pending;
      if (timer && timer.at <= clock) {
        pending = undefined;
        act(() => timer.run());
      }
    },
  };
}

const marked = () =>
  screen.getAllByRole("button").filter((button) => button.hasAttribute("aria-current"));

test("no tick is marked while the transcript is flung, and the mark returns once it settles", () => {
  const transcript = fakeTranscript();
  render(
    <ConversationRail
      markers={markers}
      height={400}
      current="second"
      scroller={transcript.ref}
      time={transcript.time}
      onJump={() => {}}
      renderPreview={preview}
    />,
  );
  expect(marked()).toHaveLength(1);
  // 3000 px in 48 ms is a fling.
  transcript.scrollTo(0, 0);
  transcript.scrollTo(1000, 16);
  transcript.scrollTo(2000, 32);
  transcript.scrollTo(3000, 48);
  expect(marked()).toHaveLength(0);
  transcript.wait(50);
  expect(marked()).toHaveLength(0);
  transcript.wait(200);
  expect(marked()).toHaveLength(1);
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
