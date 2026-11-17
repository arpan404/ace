import { describe, expect, it } from "vitest";
import { cutEnd, cutMiddle, fit, textWidth, wrap } from "./layout.ts";

describe("terminal text width", () => {
  it.each([
    ["plain", 5],
    ["日本語", 6],
    ["한국", 4],
    ["ｆｕｌｌ", 8],
    ["😀", 2],
    ["👩‍💻", 2],
    ["🇳🇵", 2],
    ["é", 1],
    ["❤️", 2],
    ["\x1b[33mamber\x1b[0m", 5],
    ["◆ ◌ ✓", 5],
  ])("measures %j as %i cells", (text, width) => {
    expect(textWidth(text)).toBe(width);
  });
});

describe("cutting lines to fit", () => {
  it("cuts a command in the middle so its start and end both stay", () => {
    const cut = cutMiddle("bun --bun x vitest run apps/daemon/src/relay.device.process.test.ts", 40);
    expect(textWidth(cut)).toBe(40);
    expect(cut.startsWith("bun --bun x")).toBe(true);
    expect(cut.endsWith("process.test.ts")).toBe(true);
    expect(cut).toContain("…");
  });

  it("never splits a wide character when cutting", () => {
    const cut = cutEnd("日本語のテキスト", 7);
    expect(textWidth(cut)).toBeLessThanOrEqual(7);
    expect(cut).toBe("日本語…");
  });

  it("cuts in the middle around emoji without breaking them", () => {
    const cut = cutMiddle("😀😀😀😀😀😀😀😀", 9);
    expect(textWidth(cut)).toBeLessThanOrEqual(9);
    expect(cut).toBe("😀😀…😀😀");
  });

  it("leaves text that fits untouched", () => {
    expect(cutMiddle("short", 10)).toBe("short");
    expect(fit("ab", 4)).toBe("ab  ");
  });
});

describe("wrapping", () => {
  it("wraps at spaces and keeps every line within the width", () => {
    const lines = wrap("The socket's close handler only schedules a reconnect when the code is 1006.", 20);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(20);
    expect(lines.join(" ")).toBe(
      "The socket's close handler only schedules a reconnect when the code is 1006.",
    );
  });

  it("breaks a word longer than the line and keeps blank lines", () => {
    expect(wrap("abcdefgh\n\nxy", 3)).toEqual(["abc", "def", "gh", "", "xy"]);
  });

  it("wraps wide characters by cells", () => {
    expect(wrap("日本語日本語", 4)).toEqual(["日本", "語日", "本語"]);
  });
});
