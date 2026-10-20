import { PublicToolCode, PublicToolError } from "@ace/mcp-server/errors";
import { expect, test } from "vitest";
import { toolProblem, type AceToolFamily } from "./ace-tool-problems.ts";

const families: AceToolFamily[] = ["screen", "browser", "device", "agents", "threads", "ace"];
/** Codes a newer daemon reports before this catalog knows them (thread tools). */
const newer = ["thread_not_found", "thread_busy", "request_conflict", "handoff_unavailable"];
const attempt = "read a thread";

test("every public tool failure reads in a person's words, never the hint written for the agent", () => {
  for (const code of PublicToolCode.options) {
    const { hint } = new PublicToolError(code);
    const problems = families.map((family) => toolProblem({ family, code, attempt }));
    for (const problem of problems) {
      expect(problem.hint).not.toBe(hint);
    }
    // The generic failure says what the step tried; every other code has its own sentence.
    const worded = problems.some((problem) => problem.title !== `Couldn't ${attempt}`);
    expect(worded, code).toBe(code !== "execution_failed");
  }
  for (const code of newer)
    expect(toolProblem({ family: "threads", code, attempt }).title, code).not.toBe(
      `Couldn't ${attempt}`,
    );
});

test("a code ace has no words for reads as what the step tried", () => {
  expect(toolProblem({ family: "browser", code: "brand_new_code", attempt }).title).toBe(
    "Couldn't read a thread",
  );
});
