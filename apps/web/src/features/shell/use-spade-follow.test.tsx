import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { expect, onTestFinished, test, vi } from "vitest";
import { SpadeMark } from "@/components/spade-mark.tsx";
import { useSpadeFollow } from "./use-spade-follow.ts";

function FollowHarness() {
  const ref = useRef<HTMLDivElement>(null);
  useSpadeFollow(ref);
  return (
    <div ref={ref} data-slot="sidebar-body">
      <nav data-slot="rail">
        <SpadeMark size={20} />
      </nav>
      <div data-slot="sidebar-panel" />
    </div>
  );
}

const markRect = {
  left: 0,
  top: 0,
  width: 20,
  height: 20,
  right: 20,
  bottom: 20,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as unknown as DOMRect;

function mockFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  const raf = vi
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation((callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    });
  const caf = vi
    .spyOn(globalThis, "cancelAnimationFrame")
    .mockImplementation((handle: number) => frames.delete(handle));
  onTestFinished(() => {
    raf.mockRestore();
    caf.mockRestore();
  });
  const flush = (rounds: number) =>
    act(() => {
      for (let round = 0; round < rounds; round++) {
        const pending = [...frames];
        frames.clear();
        for (const [, callback] of pending) callback(0);
      }
    });
  return { frames, flush };
}

function moveOver(panel: Element) {
  panel.dispatchEvent(
    new window.MouseEvent("pointermove", { bubbles: true, clientX: 200, clientY: 10 }),
  );
}

test("a pointermove over the panel turns the pupils toward it, and leaving eases them back", () => {
  const { frames, flush } = mockFrames();
  const view = render(<FollowHarness />);
  onTestFinished(() => view.unmount());
  const svg = view.container.querySelector("svg[data-mark='spade']");
  if (!svg) throw new Error("the rail draws Spade's mark");
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(markRect);
  const pupil = svg.querySelector("[data-spade-pupil='0']");
  if (!pupil) throw new Error("each eye draws a pupil");
  const panel = view.container.querySelector("[data-slot='sidebar-panel']");
  if (!panel) throw new Error("the sidebar draws its panel beside the rail");

  const rest = pupil.getAttribute("cx");
  moveOver(panel);
  flush(1);
  const looking = pupil.getAttribute("cx");
  expect(looking).not.toBe(rest);
  expect(Number(looking)).toBeGreaterThan(Number(rest));

  view.container
    .querySelector("[data-slot='sidebar-body']")
    ?.dispatchEvent(new window.MouseEvent("pointerleave", { bubbles: false }));
  flush(60);
  expect(pupil.getAttribute("cx")).toBe(rest);
  expect(frames.size).toBe(0);
});

test("under reduced motion the eyes stay at rest", () => {
  document.documentElement.setAttribute("data-reduce-motion", "");
  onTestFinished(() => document.documentElement.removeAttribute("data-reduce-motion"));
  const { frames, flush } = mockFrames();
  const view = render(<FollowHarness />);
  onTestFinished(() => view.unmount());
  const svg = view.container.querySelector("svg[data-mark='spade']");
  if (!svg) throw new Error("the rail draws Spade's mark");
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(markRect);
  const pupil = svg.querySelector("[data-spade-pupil='0']");
  if (!pupil) throw new Error("each eye draws a pupil");
  const rest = pupil.getAttribute("cx");

  const panel = view.container.querySelector("[data-slot='sidebar-panel']");
  if (!panel) throw new Error("the sidebar draws its panel beside the rail");
  moveOver(panel);
  flush(5);
  expect(pupil.getAttribute("cx")).toBe(rest);
  expect(frames.size).toBe(0);
});
