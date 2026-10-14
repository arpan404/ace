import { expect, test } from "vitest";
import { retryRequest } from "./subagent-retry.ts";

test("the request to the parent names the subagent, its task and why it failed", () => {
  const text = retryRequest({
    name: "layout-fixer",
    task: "Apply the layout fixes\nand keep the header pinned",
    ended: { kind: "failed", reason: "You've hit your session limit · resets 8:30pm" },
  });
  expect(text).toMatch(
    /^The subagent “layout-fixer” \(Apply the layout fixes\) failed: You've hit your session limit · resets 8:30pm\n/,
  );
  expect(text).toMatch(/relaunch it/);
});

test("a stopped subagent, or one whose task is its name, reads without repeating itself", () => {
  expect(retryRequest({ name: "Explore", task: "Explore", ended: { kind: "stopped" } })).toMatch(
    /^The subagent “Explore” was stopped before it finished\./,
  );
  expect(retryRequest({ name: "Explore", ended: { kind: "failed" } })).toMatch(
    /^The subagent “Explore” failed before it finished\./,
  );
});
