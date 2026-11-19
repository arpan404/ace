import { expect, test } from "vitest";
import { settingsScopePlan, type ScopeMachine } from "./settings-scope.ts";

const studio: ScopeMachine = { id: "s", name: "studio", connected: true, canOperate: true };
const mini: ScopeMachine = { id: "m", name: "mini", connected: true, canOperate: true };
const laptop: ScopeMachine = { id: "l", name: "laptop", connected: false, canOperate: true };
const shared: ScopeMachine = { id: "v", name: "shared", connected: true, canOperate: false };

test("a connected view-only machine is never a target and is called view-only, not offline", () => {
  const plan = settingsScopePlan({ all: true, current: "s", machines: [studio, shared] });
  expect(plan.send).toEqual(["s"]);
  expect(plan.footer).toBe("Saved on studio. shared is view-only from this phone.");
});

test("all machines names who takes the change, who is offline and who is view-only", () => {
  const plan = settingsScopePlan({
    all: true,
    current: "s",
    machines: [studio, mini, laptop, shared],
  });
  expect(plan.send).toEqual(["s", "m"]);
  expect(plan.footer).toBe(
    "Saved on studio and mini. laptop isn't connected and keeps its own. shared is view-only from this phone.",
  );
});

test("this machine alone, when it's view-only, takes nothing and says why", () => {
  expect(settingsScopePlan({ all: false, current: "v", machines: [studio, shared] })).toEqual({
    send: [],
    footer: "shared is view-only from this phone.",
  });
  expect(settingsScopePlan({ all: false, current: "s", machines: [studio, shared] })).toEqual({
    send: ["s"],
    footer: "Saved on studio only.",
  });
});

test("several offline or view-only machines are named together", () => {
  const away = { ...laptop, id: "a", name: "attic" };
  const other = { ...shared, id: "o", name: "office" };
  const plan = settingsScopePlan({
    all: true,
    current: "s",
    machines: [studio, laptop, away, shared, other],
  });
  expect(plan.footer).toBe(
    "Saved on studio. laptop and attic aren't connected and keep their own. shared and office are view-only from this phone.",
  );
});
