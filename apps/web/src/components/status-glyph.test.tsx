import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { StatusGlyph } from "./status-glyph.tsx";
import { agentGlyph, threadGlyph, type GlyphState } from "@ace/ui-core";

/*
 * Every glyph holds still (nothing in ace loops forever; the production build's glyphs are checked
 * for running animations in tools/web-perf/src/live-motion.process.test.ts), so each state must
 * read from its drawing alone.
 */

const liveStates = ["working", "background", "subagents"] as const;
const settledStates = [
  "needs-you",
  "done",
  "failed",
  "stopped",
  "queued",
  "paused",
  "idle",
] as const;

/** What the glyph draws: its pictures' markup, without the box's state and tone attributes. */
function drawing(state: GlyphState, still?: boolean) {
  const { unmount } = render(<StatusGlyph state={state} still={still} label={state} />);
  const glyph = screen.getByRole("img", { name: state });
  const picture = [...glyph.querySelectorAll("svg")].map((svg) => svg.outerHTML).join("");
  const live = glyph.matches("[data-live]");
  unmount();
  return { picture, live };
}

test.each(liveStates)("a %s glyph draws a picture no settled state draws", (state) => {
  const own = drawing(state).picture;
  expect(own).not.toBe("");
  for (const settled of settledStates) expect(drawing(settled).picture).not.toBe(own);
});

test("working, background and subagents glyphs each draw a picture of their own", () => {
  const pictures = liveStates.map((state) => drawing(state).picture);
  expect(new Set(pictures).size).toBe(liveStates.length);
});

test.each(liveStates)("a %s glyph is marked live while its work goes on", (state) => {
  expect(drawing(state).live).toBe(true);
});

test.each(liveStates)(
  "a %s glyph held (stale facts, a wait) keeps its picture but is no longer marked live",
  (state) => {
    const held = drawing(state, true);
    expect(held.picture).toBe(drawing(state).picture);
    expect(held.live).toBe(false);
  },
);

test.each(settledStates)("a settled %s glyph is never marked live", (state) => {
  expect(drawing(state).live).toBe(false);
});

test("a glyph draws in its state's tone unless the row names another", () => {
  render(
    <>
      <StatusGlyph state="done" label="own" />
      <StatusGlyph state="subagents" tone="waiting" label="row" />
    </>,
  );
  expect(screen.getByRole("img", { name: "own" }).dataset.tone).toBe("done");
  expect(screen.getByRole("img", { name: "row" }).dataset.tone).toBe("waiting");
});

test("a waiting thread held at its usage limit reads paused; any other wait reads queued", () => {
  expect(threadGlyph({ tone: "waiting", mark: "limited" })).toBe("paused");
  expect(threadGlyph({ tone: "waiting", mark: "none" })).toBe("queued");
  expect(threadGlyph({ tone: "working", mark: "working" })).toBe("working");
  expect(threadGlyph({ tone: "failed", mark: "unresponsive" })).toBe("failed");
});

test("an agent whose turn ended while its own work runs waits on it with three arcs", () => {
  expect(agentGlyph("waiting")).toBe("subagents");
  expect(agentGlyph("spinner")).toBe("working");
  expect(agentGlyph("stopped")).toBe("stopped");
});
