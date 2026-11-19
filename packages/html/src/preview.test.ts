import { describe, expect, it } from "vitest";
import { measuredLayoutProblems, previewReport, type PreviewMeasurement } from "./preview.ts";

const fits = { view: 360, pageWidth: 360, outside: [], clipped: [], texts: [], runs: 4 };
const at = (facts: unknown, extra: Partial<PreviewMeasurement> = {}): PreviewMeasurement => ({
  width: 360,
  contentHeight: 640,
  imageHeight: 640,
  facts,
  ...extra,
});

describe("the preview report names each layout problem an agent must fix", () => {
  it.each([
    {
      behaviour: "a page that fits says so in one line",
      measured: at(fits),
      says: ["360px: height 640px", "no sideways overflow", "no text under 11px"],
      never: ["cut", "clipped"],
    },
    {
      behaviour: "a page taller than the cap says where the image stops",
      measured: at(fits, { contentHeight: 3100, imageHeight: 2000 }),
      says: ["height 3100px (image cut at 2000px)"],
      never: [],
    },
    {
      behaviour: "elements past the frame's edge are named with how far they reach",
      measured: at({
        ...fits,
        pageWidth: 656,
        outside: [
          { element: "div.card", left: 336, width: 320 },
          { element: "table", left: 0, width: 621 },
        ],
      }),
      says: [
        "overflows sideways (page 656px)",
        "div.card 320px wide, 296px past the edge",
        "table 621px wide, 261px past the edge",
      ],
      never: ["no sideways overflow"],
    },
    {
      behaviour: "an element pushed off the left edge counts as overflow",
      measured: at({ ...fits, outside: [{ element: "svg", left: -40, width: 300 }] }),
      says: ["overflows sideways: svg 300px wide, 40px past the edge"],
      never: ["page "],
    },
    {
      behaviour: "a long list of offenders is cut to a few and counted",
      measured: at({
        ...fits,
        outside: Array.from({ length: 6 }, (_, index) => ({
          element: `li.item${index}`,
          left: 0,
          width: 400,
        })),
      }),
      says: ["li.item3", "+2 more"],
      never: ["li.item4"],
    },
    {
      behaviour: "a box hiding content sideways is reported as clipped",
      measured: at({ ...fits, clipped: [{ element: "div.clip", hidden: 287 }] }),
      says: ["no sideways overflow", "clipped: div.clip hides 287px"],
      never: [],
    },
    {
      behaviour: "text under 11px is counted with the smallest samples first",
      measured: at({
        ...fits,
        texts: [
          { text: "Body", size: 14 },
          { text: "fine print", size: 9 },
          { text: "Q1", size: 4.2 },
          { text: "edge", size: 11 },
          { text: "axis", size: 10.9 },
        ],
      }),
      says: ['3 text runs under 11px: "Q1" 4.2px, "fine print" 9px, "axis" 10.9px'],
      never: ['"Body"', '"edge"'],
    },
    {
      behaviour: "one small run reads in the singular",
      measured: at({ ...fits, texts: [{ text: "tiny", size: 8 }] }),
      says: ['1 text run under 11px: "tiny" 8px'],
      never: [],
    },
    {
      behaviour: "facts a page script mangled still give a report, not a failure",
      measured: at({ view: "wide", outside: "everything", texts: null }),
      says: ["360px: height 640px", "no sideways overflow", "no text under 11px"],
      never: [],
    },
  ])("$behaviour", ({ measured, says, never }) => {
    const report = previewReport([measured]);
    for (const text of says) expect(report).toContain(text);
    for (const text of never) expect(report).not.toContain(text);
  });

  it("gives one line per width, in the order measured", () => {
    const report = previewReport([
      at({ ...fits, outside: [{ element: "div.row", left: 0, width: 616 }] }),
      at({ ...fits, view: 760, pageWidth: 760 }, { width: 760, contentHeight: 300 }),
    ]);
    const lines = report.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^360px: .*div\.row 616px wide, 256px past the edge/);
    expect(lines[1]).toMatch(/^760px: height 300px; no sideways overflow/);
  });
});

const codes = (facts: unknown) => measuredLayoutProblems(facts).map((entry) => entry.code);

describe("publishing refuses what breaks once the page is laid out on a phone", () => {
  it("a page that fits and reads at 360px publishes", () => {
    expect(codes({ ...fits, texts: [{ text: "Axis", size: 11 }] })).toEqual([]);
  });

  it("an element past the edge is refused, naming it and how far it reaches", () => {
    const [problem] = measuredLayoutProblems({
      ...fits,
      pageWidth: 616,
      outside: [{ element: "div.card.after", left: 316, width: 300 }],
    });
    expect(problem?.code).toBe("overflow");
    expect(problem?.message).toContain("div.card.after 256px past the edge");
  });

  it("a page wider than the column is refused even when no single element is named", () => {
    expect(codes({ ...fits, pageWidth: 420 })).toEqual(["overflow"]);
  });

  it("text drawn under 9px is refused with the smallest first; 9px and up is only reported", () => {
    const problems = measuredLayoutProblems({
      ...fits,
      texts: [
        { text: "legend", size: 9 },
        { text: "tick", size: 8.5 },
        { text: "Q1", size: 4.2 },
      ],
    });
    expect(problems.map((entry) => entry.code)).toEqual(["text-too-small"]);
    expect(problems[0]?.message).toContain(
      '2 text runs render under 9px ("Q1" 4.2px, "tick" 8.5px)',
    );
    expect(problems[0]?.message).not.toContain("legend");
  });

  it("facts a page script mangled count as a page that fits", () => {
    expect(codes({ view: "wide", outside: "everything", texts: null })).toEqual([]);
  });
});
