import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  botFaceBodies,
  botFaceEars,
  botFaceEyes,
  botFaceFields,
  botFaceLine,
  botFaceRing,
  botFaceTiltDeg,
  faceColours,
  faceInk,
  facePaper,
} from "@ace/ui-core/bot-face";
import { botFaceDesignDir, generateBotFaceFiles } from "./generate-bot-faces.ts";
import { arcToCubics, fmtNum, svgFragmentToPieces, svgPathToSwift } from "./svg-to-swift.ts";

const hex = (value: string) => `0x${value.slice(1).toUpperCase()}`;

describe("generate-bot-faces", () => {
  it("keeps the committed Swift files in sync with @ace/ui-core/bot-face", async () => {
    const generated = generateBotFaceFiles();
    for (const [name, expected] of Object.entries(generated)) {
      const onDisk = await readFile(join(botFaceDesignDir, name), "utf8");
      expect(onDisk, `${name} should match generator output`).toBe(expected);
    }
  });

  it("emits every colour pair's light and dark palette from ui-core", () => {
    const swift = generateBotFaceFiles()["BotFacePalette.generated.swift"] ?? "";
    expect(swift).toContain(`static let tilt: Double = ${fmtNum(botFaceTiltDeg)}`);
    expect(swift).toContain(`static let ink: UInt32 = ${hex(faceInk)}`);
    expect(swift).toContain(`static let paper: UInt32 = ${hex(facePaper)}`);
    expect(swift).toContain(
      `case .s: ${fmtNum(botFaceRing.s)}; case .m: ${fmtNum(botFaceRing.m)}; case .l: ${fmtNum(botFaceRing.l)}`,
    );
    expect(swift).toContain(
      `case .s: ${fmtNum(botFaceLine.s)}; case .m: ${fmtNum(botFaceLine.m)}; case .l: ${fmtNum(botFaceLine.l)}`,
    );

    for (const pair of botFaceFields.pair) {
      for (const scheme of ["light", "dark"] as const) {
        const c = faceColours(pair, scheme);
        const expected =
          `case (.${pair}, ${scheme === "dark"}): return .init(` +
          `body: ${hex(c.body)}, accent: ${hex(c.accent)}, ` +
          `bodyShade: ${hex(c.bodyShade)}, accentShade: ${hex(c.accentShade)}, ` +
          `pale: ${hex(c.pale)}, visor: ${hex(c.visor)}, ` +
          `mask: ${hex(c.mask)}, blush: ${hex(c.blush)}, tongue: ${hex(c.tongue)})`;
        expect(swift).toContain(expected);
      }
    }
  });

  it("emits every eye and body metric from ui-core", () => {
    const swift = generateBotFaceFiles()["BotFacePalette.generated.swift"] ?? "";
    for (const kind of botFaceFields.eyes) {
      const e = botFaceEyes[kind];
      expect(swift).toContain(
        `case .${kind}: return .init(dx: ${fmtNum(e.dx)}, rx: ${fmtNum(e.rx)}, ry: ${fmtNum(e.ry)}, lid: ${fmtNum(e.lid)}, dy: ${fmtNum(e.dy)})`,
      );
    }
    for (const kind of botFaceFields.body) {
      const b = botFaceBodies[kind];
      const lid = b.lid === "var(--visor)" ? ".visor" : ".body";
      expect(swift).toContain(
        `case .${kind}: return .init(eyeY: ${fmtNum(b.eyeY)}, eyeScale: ${fmtNum(b.eyeScale ?? 1)}, mouthY: ${fmtNum(b.mouthY)}, ` +
          `top: CGPoint(x: ${fmtNum(b.top[0])}, y: ${fmtNum(b.top[1])}), left: ${fmtNum(b.left)}, right: ${fmtNum(b.right)}, ` +
          `cheekY: ${fmtNum(b.cheekY)}, cheekDx: ${fmtNum(b.cheekDx)}, ` +
          `light: CGPoint(x: ${fmtNum(b.light[0])}, y: ${fmtNum(b.light[1])}), lid: ${lid}, hasMouth: ${b.mouth !== "none"})`,
      );
    }
  });

  it("covers every body silhouette and ear shape from ui-core", () => {
    const bodies = generateBotFaceFiles()["BotFaceBodies.generated.swift"] ?? "";
    const parts = generateBotFaceFiles()["BotFaceParts.generated.swift"] ?? "";
    for (const kind of botFaceFields.body) {
      expect(bodies).toContain(`case .${kind}:`);
    }
    for (const kind of botFaceFields.ears) {
      if (kind === "none") continue;
      expect(parts).toContain(`case .${kind}:`);
      for (const tier of ["s", "m", "l"] as const) {
        expect(() => svgFragmentToPieces(botFaceEars[kind].back(tier))).not.toThrow();
        expect(() => svgFragmentToPieces(botFaceEars[kind].inner(tier))).not.toThrow();
      }
    }
  });
});

describe("svg-to-swift path and fragment conversion", () => {
  it("converts elliptical arcs into cubics landing on the arc's midpoint and endpoint", () => {
    // One scallop from ghost's small hem: (21, 20.2) -> (15, 20.2) with rx=3, ry=1.6, sweep=1.
    const curves = arcToCubics({ x: 21, y: 20.2 }, 3, 1.6, 0, false, true, { x: 15, y: 20.2 });
    expect(curves).toHaveLength(2);
    const [midC1, midC2, mid] = curves[0]!;
    const [, , end] = curves[1]!;
    expect(mid.x).toBeCloseTo(18, 4);
    expect(mid.y).toBeCloseTo(21.8, 4);
    expect(end.x).toBeCloseTo(15, 4);
    expect(end.y).toBeCloseTo(20.2, 4);
    expect(midC1.x).toBeCloseTo(21, 4);
    expect(midC2.y).toBeCloseTo(21.8, 4);
  });

  it("handles smooth cubic S, quadratic Q, relative moves and implicit L commands", () => {
    const lines = svgPathToSwift("M 2 3 5 6 C 7 6 8 8 10 8 S 13 10 15 10 Q 17 12 19 10 z");
    expect(lines).toEqual([
      "path.move(to: CGPoint(x: 2, y: 3))",
      "path.addLine(to: CGPoint(x: 5, y: 6))",
      "path.addCurve(to: CGPoint(x: 10, y: 8), control1: CGPoint(x: 7, y: 6), control2: CGPoint(x: 8, y: 8))",
      "path.addCurve(to: CGPoint(x: 15, y: 10), control1: CGPoint(x: 12, y: 8), control2: CGPoint(x: 13, y: 10))",
      "path.addQuadCurve(to: CGPoint(x: 19, y: 10), control: CGPoint(x: 17, y: 12))",
      "path.closeSubpath()",
    ]);
  });

  it("propagates group clipping, opacity, stroke style and element rotation", () => {
    const pieces = svgFragmentToPieces(
      `<g clip-path="url(#c)" opacity="0.5"><rect x="5.4" y="-3.2" width="4.2" height="9.6" rx="2.1" fill="var(--bs)" stroke="var(--as)" stroke-width="1.2" stroke-linecap="round" transform="rotate(-12 7.5 3)"/></g>`,
    );
    expect(pieces).toHaveLength(1);
    const piece = pieces[0]!;
    expect(piece.fill).toBe("bodyShade");
    expect(piece.fillOpacity).toBe(0.5);
    expect(piece.clipped).toBe(true);
    expect(piece.rotation).toEqual({ degrees: -12, cx: 7.5, cy: 3 });
    expect(piece.stroke).toEqual({
      tone: "accentShade",
      width: 1.2,
      opacity: 0.5,
      roundCap: true,
      roundJoin: false,
    });
  });
});
