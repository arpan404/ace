import { expect, it } from "vitest";
import { needsOpener, PopupPairing, type PopupKind } from "./popup-kind.ts";

function pairing() {
  const timers: { run(): void; cancelled: boolean }[] = [];
  const decided: [string, PopupKind | undefined][] = [];
  const pairs = new PopupPairing<string>(
    (run) => {
      const timer = { run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    (target, kind) => decided.push([target, kind]),
  );
  return { pairs, timers, decided };
}
const link = { reuse: true, url: "https://site.test/docs" };
const signIn = { reuse: false, url: "https://provider.test/consent" };

it("a popup target that arrives before its window.open waits for it, in order", () => {
  const { pairs, timers, decided } = pairing();
  pairs.arrived("first");
  pairs.arrived("second");
  expect(decided).toEqual([]);
  pairs.opened(signIn);
  pairs.opened(link);
  expect(decided).toEqual([
    ["first", signIn],
    ["second", link],
  ]);
  expect(timers.every((timer) => timer.cancelled)).toBe(true);
});

it("a window.open that comes first is kept for the next target", () => {
  const { pairs, decided } = pairing();
  pairs.opened(link);
  pairs.arrived("popup");
  expect(decided).toEqual([["popup", link]]);
});

it("a target whose window.open never comes is decided without a kind", () => {
  const { pairs, timers, decided } = pairing();
  pairs.arrived("orphan");
  timers[0]?.run();
  expect(decided).toEqual([["orphan", undefined]]);
  // A late window.open is kept for the next popup instead of pairing with the decided one.
  pairs.opened(signIn);
  pairs.arrived("next");
  expect(decided.at(-1)).toEqual(["next", signIn]);
});

it("closing the opener drops the targets still waiting", () => {
  const { pairs, decided } = pairing();
  pairs.arrived("waiting");
  const dropped: string[] = [];
  pairs.clear((target) => dropped.push(target));
  expect(dropped).toEqual(["waiting"]);
  expect(decided).toEqual([]);
});

it("only a window that keeps its opener counts as a sign-in popup", () => {
  expect(needsOpener({ windowName: "provider", windowFeatures: [] })).toBe(true);
  expect(needsOpener({ windowName: "", windowFeatures: ["width=480", "height=640"] })).toBe(true);
  expect(needsOpener({ windowName: "_blank", windowFeatures: ["noopener"] })).toBe(false);
  expect(needsOpener({ windowName: "provider", windowFeatures: ["noreferrer"] })).toBe(false);
  expect(needsOpener({ windowName: "_blank", windowFeatures: [] })).toBe(false);
});
