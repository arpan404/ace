import { expect, it } from "vitest";
import { ConductorPlan, ConductorReview } from "./index.ts";
import { plan, review } from "./test-support.ts";

it("a duplicate acceptance criterion is rejected before dispatch can create an impossible review", () => {
  const project = plan();
  const stream = project.workstreams[0];
  if (!stream) throw new Error("Stream missing");
  stream.brief.acceptance.push(stream.brief.acceptance[0] ?? "a works");
  expect(ConductorPlan.safeParse(project).success).toBe(false);
});
it("review artifact limits count encoded UTF-8 bytes", () => {
  const report = review("a");
  report.summary = "界".repeat(12000);
  report.probes[0] = "界".repeat(12000);
  expect(Buffer.byteLength(JSON.stringify(report), "utf8")).toBeGreaterThan(65_536);
  expect(ConductorReview.safeParse(report).success).toBe(false);
});
it("plan artifact limits count encoded UTF-8 bytes", () => {
  const project = plan(Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`w${i}`, []])));
  for (const stream of project.workstreams) stream.brief.instructions = "界".repeat(6000);
  expect(Buffer.byteLength(JSON.stringify(project), "utf8")).toBeGreaterThan(1_048_576);
  expect(ConductorPlan.safeParse(project).success).toBe(false);
});
