import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { StatusGlyph } from "./status-glyph.tsx";
import { agentGlyph, threadGlyph, type GlyphState } from "./status-glyph-state.ts";

/** Whether the glyph's CSS animation runs: its moving parts sit inside a `[data-live]` glyph. */
function moving(state: GlyphState, still?: boolean) {
  render(<StatusGlyph state={state} still={still} label={state} />);
  const glyph = screen.getByRole("img", { name: state });
  return glyph.matches("[data-live]") && glyph.querySelector(".aperture-part") !== null;
}

test.each(["working", "background", "subagents"] as const)("a %s glyph moves", (state) => {
  expect(moving(state)).toBe(true);
});

test.each(["working", "background", "subagents"] as const)(
  "a %s glyph held still (stale facts, a wait) stops moving",
  (state) => {
    expect(moving(state, true)).toBe(false);
  },
);

test.each(["needs-you", "done", "failed", "stopped", "queued", "paused", "idle"] as const)(
  "a settled %s glyph never moves",
  (state) => {
    expect(moving(state)).toBe(false);
  },
);

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

test("an agent whose turn ended while its own work runs waits on it with ratcheting arcs", () => {
  expect(agentGlyph("waiting")).toBe("subagents");
  expect(agentGlyph("spinner")).toBe("working");
  expect(agentGlyph("stopped")).toBe("stopped");
});
