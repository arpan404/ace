import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keyboardEnv } from "@/lib/keybindings.ts";
import { keymap } from "@/lib/keymap.ts";
import { ConversationRail } from "./conversation-rail.tsx";
import type { RailHighlightTime } from "./use-rail-highlight.ts";

const markers = [
  { id: "first", ordinal: 1, label: "Audit login" },
  { id: "second", ordinal: 2, label: "Fix retry" },
  { id: "third", ordinal: 3, label: "Run tests" },
];

const preview = (id: string) => <p>Preview {id}</p>;

function Rail({ single = false, time }: { single?: boolean; time?: RailHighlightTime }) {
  const [selected, setSelected] = useState("");
  return (
    <>
      <ConversationRail
        markers={single ? markers.slice(0, 1) : markers}
        height={400}
        onJump={setSelected}
        renderPreview={preview}
        time={time}
      />
      <output aria-label="Selected turn">{selected}</output>
    </>
  );
}

/** A clock and timers the test moves by hand. */
function fakeClock() {
  let clock = 0;
  let pending: { at: number; run: () => void } | undefined;
  const time: RailHighlightTime = {
    now: () => clock,
    after(ms, run) {
      const timer = { at: clock + ms, run };
      pending = timer;
      return () => {
        if (pending === timer) pending = undefined;
      };
    },
  };
  return {
    time,
    at(moment: number) {
      clock = moment;
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

const tickNamed = (name: string) => screen.getByRole("button", { name });

test("resting on a tick previews its turn, and a quick sweep past opens nothing", async () => {
  const clock = fakeClock();
  render(<Rail time={clock.time} />);
  const user = userEvent.setup();
  for (const name of ["Audit login", "Fix retry", "Run tests"]) {
    await user.hover(tickNamed(name));
    clock.wait(60);
  }
  expect(screen.queryByText(/Preview/)).toBeNull();
  clock.wait(100);
  expect(screen.getByText("Preview third")).toBeTruthy();
});

test("with a card open, moving to another tick switches it at once", async () => {
  const clock = fakeClock();
  render(<Rail time={clock.time} />);
  const user = userEvent.setup();
  await user.hover(tickNamed("Audit login"));
  clock.wait(200);
  expect(screen.getByText("Preview first")).toBeTruthy();
  await user.hover(tickNamed("Fix retry"));
  expect(screen.getByText("Preview second")).toBeTruthy();
  expect(screen.queryByText("Preview first")).toBeNull();
});

test("leaving the rail closes the preview, though a slip straight back keeps it open", async () => {
  const clock = fakeClock();
  render(<Rail time={clock.time} />);
  const user = userEvent.setup();
  await user.hover(tickNamed("Fix retry"));
  clock.wait(200);
  await user.unhover(tickNamed("Fix retry"));
  clock.wait(40);
  expect(screen.getByText("Preview second")).toBeTruthy();
  await user.hover(tickNamed("Run tests"));
  expect(screen.getByText("Preview third")).toBeTruthy();
  await user.unhover(tickNamed("Run tests"));
  clock.wait(200);
  expect(screen.queryByText(/Preview/)).toBeNull();
});

test("a click jumps to its turn and leaves no card behind", async () => {
  const clock = fakeClock();
  render(<Rail time={clock.time} />);
  const user = userEvent.setup();
  await user.hover(tickNamed("Fix retry"));
  clock.wait(200);
  await user.click(tickNamed("Fix retry"));
  expect(screen.getByLabelText("Selected turn").textContent).toBe("second");
  clock.wait(500);
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

function NextTurnShortcut() {
  const [pressed, setPressed] = useState(0);
  useHotkey(keymap.nextTurn.keys, () => setPressed((count) => count + 1));
  return <output aria-label="Next turn presses">{pressed}</output>;
}

test("the next-turn shortcut still works while a tick has focus", async () => {
  render(
    <>
      <Rail />
      <NextTurnShortcut />
    </>,
  );
  const user = userEvent.setup();
  await user.tab();
  const first = screen.getByRole("button", { name: "Audit login" });
  const mod = keyboardEnv().apple ? "Meta" : "Control";
  await user.keyboard(`{Shift>}{Alt>}{${mod}>}{ArrowDown}{/${mod}}{/Alt}{/Shift}`);
  expect(screen.getByLabelText("Next turn presses").textContent).toBe("1");
  // The tick keeps focus: the shortcut is not also a step along the rail.
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

test("every turn on screen draws as bright as the reader's, and the rest stay dim", () => {
  render(
    <ConversationRail
      markers={markers}
      height={400}
      current="first"
      inView={["first", "second"]}
      onJump={() => {}}
      renderPreview={preview}
    />,
  );
  const [first, second, third] = screen.getAllByRole("button");
  if (!first || !second || !third) throw new Error("expected three ticks");
  expect(colourOf(second)).toBe(colourOf(first));
  expect(colourOf(third)).not.toBe(colourOf(first));
  // Only the top turn is the reader's location; the others are merely in view.
  expect(second.getAttribute("aria-current")).toBeNull();
});

test("hovering a tick brightens it", async () => {
  render(<Rail />);
  const user = userEvent.setup();
  const resting = colourOf(tickNamed("Fix retry"));
  await user.hover(tickNamed("Fix retry"));
  expect(colourOf(tickNamed("Fix retry"))).not.toBe(resting);
});

/** How much longer than at rest a tick draws. */
function lengthOf(button: HTMLElement): number {
  const value = button.querySelector("span")?.style.getPropertyValue("--tick-scale");
  return value ? Number(value) : 1;
}

test("ticks nearest the pointer grow most, follow it, and relax when it leaves; none moves", () => {
  const nine = Array.from({ length: 9 }, (_, index) => ({
    id: String(index + 1),
    ordinal: index + 1,
    label: `Turn ${index + 1}`,
  }));
  render(
    <ConversationRail markers={nine} height={400} onJump={() => {}} renderPreview={preview} />,
  );
  const rail = screen.getByRole("navigation", { name: "Conversation turns" });
  const buttons = screen.getAllByRole("button");
  const tops = buttons.map((button) => button.style.top);
  // Nine ticks 8 px apart: the fifth sits 32 px down the rail.
  fireEvent.pointerMove(rail, { clientY: 32 });
  const lengths = buttons.map(lengthOf);
  const peak = Math.max(...lengths);
  expect(lengths[4]).toBe(peak);
  expect(peak).toBeGreaterThan(1);
  expect(lengths[3]).toBeLessThan(peak);
  expect(lengths[3]).toBeGreaterThan(1);
  expect(lengths[3]).toBeCloseTo(lengths[5] ?? 0);
  expect(lengths[2]).toBeLessThan(lengths[3] ?? 0);
  expect(lengths[0]).toBe(1);
  expect(lengths[8]).toBe(1);
  fireEvent.pointerMove(rail, { clientY: 0 });
  expect(lengthOf(buttons[0] ?? rail)).toBe(peak);
  expect(lengthOf(buttons[4] ?? rail)).toBeLessThan(peak);
  expect(buttons.map((button) => button.style.top)).toEqual(tops);
  fireEvent.pointerLeave(rail);
  expect(buttons.map(lengthOf)).toEqual(buttons.map(() => 1));
});

/** A transcript whose scroll position and clock the test moves by hand. */
function fakeTranscript() {
  const element = document.createElement("div");
  let top = 0;
  Object.defineProperty(element, "scrollTop", { get: () => top });
  const clock = fakeClock();
  return {
    ref: { current: element },
    time: clock.time,
    scrollTo(position: number, at: number) {
      clock.at(at);
      top = position;
      act(() => void element.dispatchEvent(new Event("scroll")));
    },
    wait: clock.wait,
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
