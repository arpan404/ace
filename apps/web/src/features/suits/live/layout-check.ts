import type { SuitProblem } from "@ace/protocol/suits";
import type { Box } from "./colour-check.ts";

/*
 * The live check's layout rules (ADR 0150, "Shown perfectly"): protected parts stay visible,
 * whole and on top, and no part spills out of its region. The DOM shell measures; this decides.
 * Pure.
 */

/** A protected part as rendered (`protectedSuitParts`). */
export interface ProtectedSample {
  part: string;
  box: Box;
  display: string;
  visibility: string;
  /** Its opacity times every ancestor's. */
  opacity: number;
  /**
   * Whether the topmost element at the box's centre is the part or inside it; `offscreen` when
   * the centre is outside the window (scrolled away), where nothing can be hit-tested.
   */
  hit: boolean | "offscreen";
}

/** The smallest a protected part may be drawn, px on each side. */
export const protectedMinimum: Readonly<Record<string, { width: number; height: number }>> = {
  "status-icon": { width: 6, height: 6 },
  "working-line": { width: 40, height: 12 },
  "approval-strip": { width: 120, height: 24 },
  "question-card": { width: 120, height: 32 },
};
const fallbackMinimum = { width: 6, height: 6 };

export function protectedProblems(
  samples: readonly ProtectedSample[],
  scheme: "light" | "dark",
): SuitProblem[] {
  const problems = new Map<string, string>();
  const say = (part: string, message: string) => {
    if (!problems.has(part)) problems.set(part, message);
  };
  for (const sample of samples) {
    const { part, box } = sample;
    if (sample.display === "none") {
      say(part, `${part} is hidden (display: none); ace's state markers must always show.`);
      continue;
    }
    if (sample.visibility !== "visible") {
      say(part, `${part} is hidden (visibility: ${sample.visibility}); it must stay visible.`);
      continue;
    }
    if (sample.opacity < 0.99) {
      say(
        part,
        `${part} shows at opacity ${sample.opacity.toFixed(2)}, counting its containers; it must show at full opacity.`,
      );
      continue;
    }
    const minimum = protectedMinimum[part] ?? fallbackMinimum;
    if (box.width < minimum.width || box.height < minimum.height) {
      say(
        part,
        `${part} is drawn ${Math.round(box.width)}×${Math.round(box.height)} px; it needs at least ${minimum.width}×${minimum.height}.`,
      );
      continue;
    }
    if (sample.hit === false)
      say(
        part,
        `${part} is covered at its centre by something else (an ornament, a pseudo-element or a layer); nothing may sit over it.`,
      );
  }
  return [...problems].map(([part, message]) => ({
    scheme,
    check: "protected",
    field: part,
    message,
  }));
}

/** A part and the region it sits in, measured at one width. */
export interface OverflowSample {
  part: string;
  /** The nearest region part around it (`suitRegions`). */
  region: string;
  box: Box;
  regionBox: Box;
  /** A container between the two scrolls sideways, so reaching past the region is by design. */
  scrolls: boolean;
  /** Its own content is wider than it and spills out visibly (`overflow-x: visible`). */
  spills: boolean;
}

/** How far past its region a part may reach before it counts, px (sub-pixel rounding). */
const slack = 1;

const reachesOut = (sample: OverflowSample) =>
  !sample.scrolls &&
  (sample.box.left < sample.regionBox.left - slack ||
    sample.box.left + sample.box.width > sample.regionBox.left + sample.regionBox.width + slack);

/**
 * One `overflow` problem per part that spills, naming the widths it spills at. `measured` holds
 * the samples at each window width checked; `simulated` widths were made by narrowing the app's
 * container, not the window.
 */
export function overflowProblems(
  measured: readonly { width: number; simulated: boolean; samples: readonly OverflowSample[] }[],
  scheme: "light" | "dark",
): SuitProblem[] {
  const found = new Map<string, { region: string; widths: string[]; how: Set<string> }>();
  for (const { width, simulated, samples } of measured)
    for (const sample of samples) {
      const out = reachesOut(sample);
      if (!out && !sample.spills) continue;
      const entry = found.get(sample.part) ?? { region: sample.region, widths: [], how: new Set() };
      const label = `${width} px${simulated ? " (simulated)" : ""}`;
      if (!entry.widths.includes(label)) entry.widths.push(label);
      if (out) entry.how.add(`reaches past the ${sample.region}'s edge`);
      if (sample.spills) entry.how.add("its content spills out of it");
      found.set(sample.part, entry);
    }
  return [...found].map(([part, entry]) => ({
    scheme,
    check: "overflow",
    field: part,
    message: `${part} ${[...entry.how].join(" and ")} at ${entry.widths.join(", ")}; keep it inside the ${entry.region} (narrower padding, wrapping text, or a smaller fixed width).`,
  }));
}
