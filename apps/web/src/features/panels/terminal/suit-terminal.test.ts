import { afterEach, describe, expect, it } from "vitest";
import { contrastRatio, parseOpaqueColor } from "@/theme/contrast.ts";
import { fakeSuit } from "@/test/fake-suits.ts";
import { loadFaces } from "./fonts.ts";
import { minimumTextContrast, type Rgb } from "./palette.ts";
import { terminalLook } from "./suit-terminal.ts";
import { themeFor } from "./xterm-theme.ts";

const parse = (value: string): Rgb => {
  const parsed = parseOpaqueColor(value);
  if (!parsed) throw new Error(`not a colour: ${value}`);
  return parsed;
};

/** A terminal box on a dark panel, as the side panel draws it. */
function terminalBox(): HTMLElement {
  const panel = document.createElement("div");
  panel.style.backgroundColor = "rgb(20, 20, 24)";
  panel.style.setProperty("--foreground", "#ececec");
  const box = document.createElement("div");
  panel.append(box);
  document.body.append(panel);
  return box;
}
afterEach(() => document.body.replaceChildren());

const crt = fakeSuit({
  id: "crt",
  dark: { canvas: "#050805" },
  fonts: { mono: { asset: "assets/vt.woff2", family: "VT323" } },
  terminal: {
    fontFamily: "VT323",
    fontSize: 16,
    lineHeight: 1.5,
    letterSpacing: 1,
    cursorStyle: "underline",
    cursorBlink: true,
    reveal: 0.5,
    dark: {
      background: "#001100",
      foreground: "#33ff66",
      cursor: "#ccffcc",
      selection: "#33ff6640",
      ansi: { red: "#220000", brightGreen: "#88ff88" },
    },
  },
});
crt.assets["assets/vt.woff2"] = "/suits/crt/assets/vt.woff2";

describe("the terminal without a Suit", () => {
  it("draws ace's own look: 13px text on 20px rows, a steady block cursor, opaque", () => {
    const look = terminalLook(null, "dark");
    expect(look).toMatchObject({
      fontFamily: undefined,
      faces: [],
      fontSize: 13,
      row: 20,
      letterSpacing: 0,
      cursorStyle: "block",
      cursorBlink: false,
      reveal: 0,
    });
    const box = terminalBox();
    // The colours are the theme's own, with an opaque background.
    expect(themeFor(box, look)).toEqual(themeFor(box));
    expect(themeFor(box, look).background).toMatch(/^rgb\(/);
  });

  it("keeps ace's look for a Suit that leaves the terminal alone", () => {
    const plain = fakeSuit({ id: "plain", dark: { canvas: "#101010" } });
    expect(terminalLook(plain, "dark")).toEqual(terminalLook(null, "dark"));
  });
});

describe("the terminal under a Suit", () => {
  it("takes the Suit's font, size, line height, spacing and cursor", () => {
    const look = terminalLook(crt, "dark");
    expect(look).toMatchObject({
      fontSize: 16,
      row: 24,
      letterSpacing: 1,
      cursorStyle: "underline",
      cursorBlink: true,
    });
  });

  it("draws a bundled family with the Suit's own file, and waits for it before measuring", () => {
    const look = terminalLook(crt, "dark");
    expect(look.fontFamily).toBe('"ace-suit-crt-mono"');
    expect(look.faces).toEqual(['16px "ace-suit-crt-mono"']);
  });

  it("uses a system family as given, and refuses one that could break out of the font list", () => {
    const system = (fontFamily: string) =>
      terminalLook(fakeSuit({ id: "sys", dark: {}, terminal: { fontFamily } }), "dark").fontFamily;
    expect(system('"Berkeley Mono", monospace')).toBe('"Berkeley Mono", monospace');
    expect(system("Menlo; } body { color: red")).toBeUndefined();
  });

  it("paints the Suit's colours, with ANSI colours fitted to read on its background", () => {
    const colours = themeFor(terminalBox(), { ...terminalLook(crt, "dark"), reveal: 0 });
    const background = parse(colours.background);
    expect(background).toEqual([0, 17, 0]);
    expect(colours.foreground).toBe("rgb(51, 255, 102)");
    expect(colours.cursor).toBe("rgb(204, 255, 204)");
    expect(colours.selectionBackground).toBe("rgba(51, 255, 102, 0.25098039215686274)");
    // The Suit's near-black red is lifted until it reads; its bright green is used as given.
    expect(contrastRatio(parse(colours.red), background)).toBeGreaterThanOrEqual(
      minimumTextContrast,
    );
    expect(colours.red).not.toBe("rgb(34, 0, 0)");
    expect(colours.brightGreen).toBe("rgb(136, 255, 136)");
  });

  it("lets the panel show through the background by the Suit's reveal, held under what reads", () => {
    const colours = themeFor(terminalBox(), terminalLook(crt, "dark"));
    const alpha = Number(/rgba\(0, 17, 0, ([\d.]+)\)/.exec(colours.background)?.[1]);
    expect(alpha).toBeGreaterThanOrEqual(0.5);
    expect(alpha).toBeLessThan(1);
  });

  it("uses the scheme's own colours, deriving the scheme the Suit leaves out", () => {
    const box = terminalBox();
    const light = themeFor(box, terminalLook(crt, "light"));
    expect(light.background).not.toContain("0, 17, 0");
    expect(light.foreground).toBe(themeFor(box).foreground);
  });
});

describe("waiting for bundled faces", () => {
  it("returns once every face loads", async () => {
    const asked: string[] = [];
    await loadFaces(['16px "a"', '16px "b"'], {
      load: async (face) => {
        asked.push(face);
        return [];
      },
    });
    expect(asked).toEqual(['16px "a"', '16px "b"']);
  });

  it("gives up after its bound when a face never loads", async () => {
    const started = performance.now();
    await loadFaces(['16px "never"'], { load: () => new Promise(() => {}) }, 20);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
