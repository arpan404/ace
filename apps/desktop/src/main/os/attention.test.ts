import { afterEach, expect, test, vi } from "vitest";
import { DesktopSettings } from "../../shared/contract.ts";

const effects = vi.hoisted(() => ({
  blockers: new Set<number>(),
  bounces: [] as string[],
  next: 0,
}));
vi.mock("electron", () => ({
  app: { setBadgeCount() {}, dock: { bounce: (reason: string) => effects.bounces.push(reason) } },
  nativeImage: {},
  powerSaveBlocker: {
    start: () => {
      const id = ++effects.next;
      effects.blockers.add(id);
      return id;
    },
    stop: (id: number) => effects.blockers.delete(id),
  },
}));
import { Attention } from "./attention.ts";

afterEach(() => {
  effects.blockers.clear();
  effects.bounces.length = 0;
});

test("prevent sleep follows working agents and changing the preference applies immediately", () => {
  let settings = DesktopSettings.parse({ preventSleep: true });
  const attention = new Attention(
    () => settings,
    () => undefined,
  );
  attention.update({ needsYou: 0, working: 2 });
  expect(effects.blockers.size).toBe(1);
  attention.update({ needsYou: 0, working: 1 });
  expect(effects.blockers.size).toBe(1);
  settings = { ...settings, preventSleep: false };
  attention.refresh();
  expect(effects.blockers.size).toBe(0);
  settings = { ...settings, preventSleep: true };
  attention.refresh();
  expect(effects.blockers.size).toBe(1);
  attention.update({ needsYou: 1, working: 0 });
  expect(effects.blockers.size).toBe(0);
});

test.skipIf(process.platform !== "darwin")(
  "dock attention follows the preference when new work needs a person",
  () => {
    let settings = DesktopSettings.parse({ attention: false });
    const attention = new Attention(
      () => settings,
      () => undefined,
    );
    attention.update({ needsYou: 1, working: 0 });
    expect(effects.bounces).toEqual([]);
    settings = { ...settings, attention: true };
    attention.refresh();
    expect(effects.bounces).toEqual([]);
    attention.update({ needsYou: 2, working: 0 });
    expect(effects.bounces).toEqual(["informational"]);
  },
);
