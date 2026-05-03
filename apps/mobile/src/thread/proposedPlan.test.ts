import { describe, expect, it } from "vitest";
import {
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
  buildProposedPlanPreview,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "./proposedPlan";

describe("proposedPlan", () => {
  it("derives mobile plan titles and implementation prompts", () => {
    const plan = "# Fix sync\n\n- Update the cache\n- Add tests";

    expect(proposedPlanTitle(plan)).toBe("Fix sync");
    expect(buildPlanImplementationThreadTitle(plan)).toBe("Implement Fix sync");
    expect(buildPlanImplementationPrompt(plan)).toBe(`PLEASE IMPLEMENT THIS PLAN:\n${plan}`);
  });

  it("strips duplicated headings and summary sections from the displayed body", () => {
    expect(stripDisplayedPlanMarkdown("# Plan\n\n## Summary\n\nShip the fix")).toBe("Ship the fix");
  });

  it("builds a bounded mobile preview", () => {
    const plan = [
      "# Plan",
      "",
      "- one",
      "- two",
      "- three",
      "- four",
      "- five",
      "- six",
      "- seven",
      "- eight",
      "- nine",
    ].join("\n");

    expect(buildProposedPlanPreview(plan)).toBe(
      [
        "- one",
        "- two",
        "- three",
        "- four",
        "- five",
        "- six",
        "- seven",
        "- eight",
        "",
        "...",
      ].join("\n"),
    );
  });
});
