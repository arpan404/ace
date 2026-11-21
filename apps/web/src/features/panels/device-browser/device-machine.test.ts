import { describe, expect, it } from "vitest";
import { deviceTabMachine } from "./device-machine.ts";

describe("where the person's pages run", () => {
  const remote = { machine: { id: "host-b", primary: false } };
  const own = { machine: { id: "host-a", primary: true } };
  it.each([
    ["another machine's thread in the desktop app runs them here", remote, true, "host-b"],
    ["this window's own machine keeps its native views", own, true, undefined],
    ["a thread outside any machine scope is this window's own", undefined, true, undefined],
    ["a browser keeps ace's Chrome as video", remote, false, undefined],
  ])("%s", (_name, scoped, desktop, expected) => {
    expect(deviceTabMachine(scoped, desktop)).toBe(expected);
  });
});
