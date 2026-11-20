import { expect, test } from "vitest";
import { DesktopSettings } from "../shared/contract.ts";
import { talkIndicatorWords, talkPress, talkShortcutOf, withTalkDefault } from "./spade-talk.ts";

test("push to talk is ⌥Space on macOS until the person picks another chord or turns it off", () => {
  const fresh = DesktopSettings.parse({});
  expect(talkShortcutOf(fresh, "darwin")).toBe("Alt+Space");
  // Elsewhere the chord belongs to the system (Windows' window menu, many Linux desktops).
  expect(talkShortcutOf(fresh, "win32")).toBeNull();
  expect(talkShortcutOf(fresh, "linux")).toBeNull();
  const chosen = DesktopSettings.parse({ spadeTalkShortcut: "CommandOrControl+Shift+Space" });
  expect(talkShortcutOf(chosen, "linux")).toBe("CommandOrControl+Shift+Space");
  expect(talkShortcutOf(DesktopSettings.parse({ spadeTalkShortcut: null }), "darwin")).toBeNull();
  // The page is shown the chord in force.
  expect(withTalkDefault(fresh, "darwin").spadeTalkShortcut).toBe("Alt+Space");
});

test("the first press listens, the next sends, and one over Spade's answer listens again", () => {
  expect(talkPress("off")).toBe("start");
  for (const state of ["listening", "hearing", "transcribing"] as const)
    expect(talkPress(state)).toBe("send");
  for (const state of ["thinking", "speaking"] as const) expect(talkPress(state)).toBe("start");
});

test("the indicator says where the turn is in words, and goes once it is over", () => {
  expect(talkIndicatorWords("listening")).toMatch(/^Listening/);
  expect(talkIndicatorWords("speaking")).toBe("Spade is speaking");
  expect(talkIndicatorWords("off")).toBeUndefined();
});
