import { describe, expect, it } from "vitest";
import { fakeSuit } from "@/test/fake-suits.ts";
import { memoryKeyValue } from "@/test/harness.tsx";
import { appliedSuit, wantedSuit } from "./applied-suit.ts";
import { suitsOffForSession } from "./suits-off.ts";

const dusk = fakeSuit({ id: "dusk-sky", dark: { canvas: "#101020" } });
const broken = fakeSuit(
  { id: "broken", dark: { canvas: "#101020" } },
  {
    problems: [{ scheme: "dark", check: "contrast", field: "muted", message: "Too faint." }],
  },
);
const base = {
  setting: "dusk-sky",
  off: false,
  summaries: [dusk.summary, broken.summary],
  detail: dusk,
  cached: undefined,
};

describe("which Suit the page shows", () => {
  it("shows the picked Suit once it is listed and read", () => {
    expect(appliedSuit(base)?.summary.id).toBe("dusk-sky");
  });

  it("falls back to the theme when nothing is picked, Suits are off, or it isn't installed", () => {
    expect(appliedSuit({ ...base, setting: null })).toBeNull();
    expect(appliedSuit({ ...base, off: true })).toBeNull();
    expect(appliedSuit({ ...base, summaries: [broken.summary] })).toBeNull();
  });

  it("never shows a Suit that has problems", () => {
    expect(appliedSuit({ ...base, setting: "broken", detail: broken })).toBeNull();
  });

  it("keeps last launch's Suit until the daemon answers, then follows the daemon", () => {
    const waiting = { ...base, summaries: undefined, detail: undefined, cached: dusk };
    expect(appliedSuit(waiting)?.summary.id).toBe("dusk-sky");
    expect(appliedSuit({ ...waiting, summaries: [] })).toBeNull();
  });

  it("holds the shown version while a newer one is read", () => {
    const newer = { ...dusk.summary, contentHash: "hash-2" };
    const inputs = { ...base, summaries: [newer], detail: dusk, cached: dusk };
    expect(appliedSuit(inputs)).toBe(dusk);
    expect(appliedSuit({ ...inputs, cached: undefined })).toBeNull();
  });

  it("an agent's preview wins over the setting until it ends", () => {
    expect(wantedSuit("dusk-sky", "broken")).toBe("broken");
    expect(wantedSuit("dusk-sky", null)).toBeNull();
    expect(wantedSuit("dusk-sky", undefined)).toBe("dusk-sky");
  });
});

describe("?suit=off", () => {
  it("turns Suits off for the rest of the session, and ?suit=on turns them back on", () => {
    const session = memoryKeyValue();
    expect(suitsOffForSession("", session)).toBe(false);
    expect(suitsOffForSession("?suit=off", session)).toBe(true);
    expect(suitsOffForSession("?thread=1", session)).toBe(true);
    expect(suitsOffForSession("?suit=on", session)).toBe(false);
  });

  it("still works where session storage is denied", () => {
    const denied = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(suitsOffForSession("?suit=off", denied)).toBe(true);
  });
});
