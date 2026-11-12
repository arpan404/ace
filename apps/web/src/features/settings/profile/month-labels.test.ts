import { describe, expect, test } from "vitest";
import {
  monthLabelGap,
  monthLabelWidth,
  visibleMonthLabels,
  type MonthLabel,
} from "./month-labels.ts";

const at = (label: string, x: number, width = monthLabelWidth(label)): MonthLabel => ({
  label,
  x,
  width,
});

/** The labels a strip of `containerWidth` px keeps, in order. */
const shownIn = (labels: readonly MonthLabel[], containerWidth: number) =>
  visibleMonthLabels(labels, containerWidth, monthLabelGap).map((month) => month.label);

describe("month labels under the activity grid", () => {
  test.each([
    {
      name: "every month shows when there is room between them",
      labels: [at("Nov", 0), at("Dec", 60), at("Jan", 120), at("Feb", 180)],
      containerWidth: 220,
      shown: ["Nov", "Dec", "Jan", "Feb"],
    },
    {
      name: "labels that would overlap at narrow widths are skipped",
      labels: [
        at("Nov", 0),
        at("Dec", 24),
        at("Jan", 48),
        at("Feb", 72),
        at("Mar", 96),
        at("Apr", 120),
      ],
      containerWidth: 200,
      shown: ["Nov", "Jan", "Mar"],
    },
    {
      name: "labels that would run past the right edge are skipped",
      labels: [at("Nov", 0), at("Dec", 180), at("Jan", 190)],
      containerWidth: 200,
      shown: ["Nov"],
    },
    {
      name: "a label that ends exactly on the right edge is kept",
      labels: [at("Nov", 0), at("Dec", 200 - monthLabelWidth("Dec"))],
      containerWidth: 200,
      shown: ["Nov", "Dec"],
    },
    {
      name: "a month with no room for even one label shows none",
      labels: [at("Nov", 0)],
      containerWidth: monthLabelWidth("Nov") - 1,
      shown: [],
    },
  ])("$name", ({ labels, containerWidth, shown }) => {
    expect(shownIn(labels, containerWidth)).toEqual(shown);
  });

  test("a skipped label does not crowd out the next one that has room", () => {
    // Dec is squeezed against Nov, but Jan sits clear of Nov's end, not Dec's.
    const labels = [at("Nov", 0), at("Dec", 24), at("Jan", 46)];
    expect(shownIn(labels, 100)).toEqual(["Nov", "Jan"]);
  });
});
