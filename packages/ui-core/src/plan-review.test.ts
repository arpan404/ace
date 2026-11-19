import { expect, test } from "vitest";
import { planReviewLine } from "./plan-review.ts";

test("a plan says its title and how many top-level steps it has", () => {
  const markdown = [
    "## Steps",
    "1. Record each child's start time",
    "   - nested detail that is not a step",
    "2. Add `--thread` and `--project` filters",
    "3. Skip any PID whose start time no longer matches",
    "",
    "```sh",
    "1. not a step inside code",
    "```",
  ].join("\n");
  expect(planReviewLine({ title: "Kill-all filters", markdown })).toBe(
    "Plan ready · Kill-all filters · 3 steps",
  );
});

test("the plan's own todo list counts before its text, and one step reads singular", () => {
  expect(planReviewLine({ title: "Ship", markdown: "- a\n- b", todos: [{}] })).toBe(
    "Plan ready · Ship · 1 step",
  );
});

test("a plan with no list and no title of its own just says it is ready", () => {
  expect(planReviewLine({ title: "Review the plan", markdown: "Just do it." })).toBe("Plan ready");
});
