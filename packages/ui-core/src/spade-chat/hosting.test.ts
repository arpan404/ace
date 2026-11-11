import { expect, test } from "vitest";
import { spadeHostPlan } from "./index.ts";

test("the oldest Spade stays on and every other machine's is switched off", () => {
  expect(
    spadeHostPlan([
      { host: "b-studio", main: { createdAt: 5 } },
      { host: "a-laptop", main: { createdAt: 9 } },
      { host: "c-server", main: undefined },
    ]),
  ).toEqual({ keep: "b-studio", disable: ["a-laptop"], enable: undefined });
});

test("two Spades made at the same moment keep one, whatever order a window lists them in", () => {
  const seen = [
    { host: "studio", main: { createdAt: 7 } },
    { host: "laptop", main: { createdAt: 7 } },
  ];
  const plans = [spadeHostPlan(seen), spadeHostPlan(seen.toReversed())];
  expect(plans[0]).toEqual({ keep: "laptop", disable: ["studio"], enable: undefined });
  expect(plans[1]).toEqual(plans[0]);
});

test("with no machine showing Spade, one is switched back on", () => {
  expect(
    spadeHostPlan([
      { host: "studio", main: undefined },
      { host: "laptop", main: undefined },
    ]),
  ).toEqual({ keep: "laptop", disable: [], enable: "laptop" });
  expect(spadeHostPlan([])).toEqual({ keep: undefined, disable: [], enable: undefined });
});
