import { expect, it } from "vitest";
import { z } from "zod";
import { ComputerAction } from "./actions.ts";
import { computerSchemas } from "./schemas.ts";

const issues = (value: unknown) => {
  const parsed = ComputerAction.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`);
};

it("accepts each kind of step with the fields it takes", () => {
  for (const step of [
    { type: "click", id: 3, modifiers: ["cmd"] },
    { type: "click", x: 10, y: 20, count: 2 },
    { type: "paste", text: "# Title", format: "markdown" },
    { type: "drag", from: [1, 2], to: { id: 4 } },
    { type: "window", op: "move", x: -100, y: 0 },
    { type: "if", text: "Save", steps: 2 },
  ])
    expect(issues(step), JSON.stringify(step)).toEqual([]);
});

it("refuses a field the step does not take, naming it", () => {
  expect(issues({ type: "click", id: 3, text: "hi" }).join()).toMatch(/text/);
  expect(issues({ type: "focus", id: 3, direction: "up" }).join()).toMatch(/direction/);
});

it("keeps each step's own bounds and cross-field rules", () => {
  expect(issues({ type: "click" }).join()).toMatch(/click needs id or x,y/);
  expect(issues({ type: "click", x: -5, y: 1 })).not.toEqual([]);
  expect(issues({ type: "type", text: "x".repeat(5001) })).not.toEqual([]);
  expect(issues({ type: "window", op: "resize", width: 100 }).join()).toMatch(/width and height/);
  expect(issues({ type: "scroll", direction: "down", pages: 1, pixels: 10 }).join()).toMatch(
    /pages or pixels/,
  );
});

it("screen_act's schema, sent with every request, stays small", () => {
  const advertised = JSON.stringify(z.toJSONSchema(computerSchemas.screen_act, { io: "input" }));
  expect(advertised.length).toBeLessThan(5_000);
});
