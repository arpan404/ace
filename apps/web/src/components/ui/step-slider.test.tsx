import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test } from "vitest";
import { StepSlider } from "./step-slider.tsx";

const steps = ["minimal", "low", "medium", "high"];
const names: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
};

function Effort(props: { disabled?: boolean; start?: number; unselected?: boolean }) {
  const [value, setValue] = useState<number | undefined>(
    props.unselected ? undefined : (props.start ?? 0),
  );
  return (
    <StepSlider
      label="Effort"
      steps={steps}
      value={value}
      unselectedLabel="Choose effort"
      stepLabel={(step) => names[step] ?? step}
      onValueChange={setValue}
      disabled={props.disabled}
    />
  );
}

/** The slider, laid out 226px wide from x=0: its stops sit at 13, 79, 146 and 213. */
function slider() {
  const element = screen.getByRole("slider", { name: "Effort" });
  element.getBoundingClientRect = () => new DOMRect(0, 0, 226, 22);
  return element;
}
const reads = () => screen.getByRole("slider", { name: "Effort" }).getAttribute("aria-valuetext");

test("arrow, Page, Home and End keys step through the levels and stop at the ends", async () => {
  render(<Effort />);
  slider().focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(reads()).toBe("Low");
  await userEvent.keyboard("{PageUp}{ArrowUp}");
  expect(reads()).toBe("High");
  await userEvent.keyboard("{ArrowRight}");
  expect(reads()).toBe("High");
  await userEvent.keyboard("{PageDown}");
  expect(reads()).toBe("Medium");
  await userEvent.keyboard("{Home}");
  expect(reads()).toBe("Minimal");
  await userEvent.keyboard("{ArrowLeft}");
  expect(reads()).toBe("Minimal");
  await userEvent.keyboard("{End}");
  expect(reads()).toBe("High");
});

test("a press lands on the nearest level and a drag follows the pointer until it lets go", () => {
  render(<Effort />);
  const track = slider();
  fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: 140 });
  expect(reads()).toBe("Medium");
  fireEvent.pointerMove(track, { pointerId: 1, clientX: 90 });
  expect(reads()).toBe("Low");
  fireEvent.pointerMove(track, { pointerId: 1, clientX: 400 });
  expect(reads()).toBe("High");
  fireEvent.pointerUp(track, { pointerId: 1, clientX: 400 });
  // Released: moving over the track no longer changes anything.
  fireEvent.pointerMove(track, { pointerId: 1, clientX: 0 });
  expect(reads()).toBe("High");
});

test("a secondary button press doesn't move it", () => {
  render(<Effort start={1} />);
  fireEvent.pointerDown(slider(), { pointerId: 1, button: 2, clientX: 213 });
  expect(reads()).toBe("Low");
});

test("a disabled slider ignores keys and the pointer", async () => {
  render(<Effort disabled start={2} />);
  const track = slider();
  expect(track.tabIndex).toBe(-1);
  track.focus();
  await userEvent.keyboard("{End}");
  fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: 0 });
  expect(reads()).toBe("Medium");
});

test("a second pointer can neither move nor end the first one's drag", () => {
  render(<Effort />);
  const track = slider();
  fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: 79 });
  expect(reads()).toBe("Low");
  fireEvent.pointerDown(track, { pointerId: 2, button: 0, clientX: 213 });
  fireEvent.pointerMove(track, { pointerId: 2, clientX: 213 });
  expect(reads()).toBe("Low");
  fireEvent.pointerUp(track, { pointerId: 2, clientX: 213 });
  fireEvent.pointerMove(track, { pointerId: 1, clientX: 146 });
  expect(reads()).toBe("Medium");
});

test("a drag ends when the slider loses the pointer", () => {
  render(<Effort />);
  const track = slider();
  fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: 79 });
  fireEvent.lostPointerCapture(track, { pointerId: 1 });
  fireEvent.pointerMove(track, { pointerId: 1, clientX: 213 });
  expect(reads()).toBe("Low");
});

test("an unset effort stays neutral until a first-stop click explicitly chooses it", () => {
  render(<Effort unselected />);
  expect(reads()).toBe("Choose effort");
  fireEvent.pointerDown(slider(), { pointerId: 1, button: 0, clientX: 13 });
  expect(reads()).toBe("Minimal");
});

test("an unset slider starts with the first actual level and keyboard reaches every level", async () => {
  render(<Effort unselected />);
  slider().focus();
  expect(reads()).toBe("Choose effort");
  for (const name of ["Minimal", "Low", "Medium", "High"]) {
    await userEvent.keyboard("{ArrowRight}");
    expect(reads()).toBe(name);
  }
  await userEvent.keyboard("{Home}");
  expect(reads()).toBe("Minimal");
  await userEvent.keyboard("{End}");
  expect(reads()).toBe("High");
});

test("an accepted primary drag cancels native selection and retains focus", () => {
  render(<Effort />);
  const track = slider();
  expect(fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: 140 })).toBe(false);
  expect(document.activeElement).toBe(track);
  expect(reads()).toBe("Medium");
  fireEvent.pointerCancel(track, { pointerId: 1 });
  fireEvent.pointerMove(track, { pointerId: 1, clientX: 213 });
  expect(reads()).toBe("Medium");
  expect(track.hasAttribute("data-dragging")).toBe(false);
  expect(fireEvent.pointerDown(track, { pointerId: 2, button: 0, clientX: 13 })).toBe(false);
  expect(reads()).toBe("Minimal");
});
