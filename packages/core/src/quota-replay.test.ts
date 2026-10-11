import { expect, test } from "vitest";
import { harness } from "./test-helper.ts";

const quota = {
  type: "turn.ended",
  agent: "root",
  nativeTurnId: "old",
  outcome: "failed",
  error: { kind: "quota", message: "Usage limit reached" },
} as const;

test("a repeated settled quota failure cannot restore a cleared limit", () => {
  const h = harness();
  h.start("root", "old");
  h.send(quota);
  expect(h.view.status.state).toBe("limited");
  h.send({ type: "limit.cleared", agent: "root" });
  h.start("root", "new");
  h.send({ type: "turn.ended", agent: "root", nativeTurnId: "new", outcome: "completed" });
  h.send(quota);
  expect(h.view.status.state).toBe("done");
  expect(Object.values(h.view.runs)).toHaveLength(2);
});

test("a delayed older quota end cannot limit a newer active turn", () => {
  const h = harness();
  h.start("root", "new");
  h.send(quota);
  expect(h.view.status.state).toBe("working");
});
