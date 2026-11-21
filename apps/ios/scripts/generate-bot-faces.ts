import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  botFaceAccessoryMarkup,
  botFaceBodies,
  botFaceDefaults,
  botFaceEars,
  botFaceEyes,
  botFaceFields,
  botFaceLine,
  botFaceMarkings,
  botFaceRing,
  botFaceTiltDeg,
  faceColours,
  faceInk,
  facePaper,
  type BotFaceValue,
  type FaceTier,
} from "@ace/ui-core/bot-face";
import {
  fmtNum,
  fmtPoint,
  svgFragmentToPieces,
  svgShapesToSwiftPath,
  type SwiftPiece,
} from "./svg-to-swift.ts";

/*
 * Generates BotFace{Palette,Bodies,Parts}.generated.swift in `Sources/Design/` from
 * `@ace/ui-core/bot-face`: every colour pair (light and dark, all nine derived roles),
 * every eye and body metric, and every body silhouette, decoration, ear, static marking
 * and scarf on the 24 box.
 *
 *   bun scripts/generate-bot-faces.ts
 *   bun scripts/generate-bot-faces.ts --check
 */

const tierSize: Record<FaceTier, number> = { s: 20, m: 32, l: 56 };
const hexLiteral = (hex: string): string => `0x${hex.slice(1).toUpperCase()}`;

function emitPieceCall(piece: SwiftPiece, indent: string): string[] {
  const args: string[] = [];
  if (piece.fill !== null) args.push(`fill: .${piece.fill}`);
  if (piece.fillOpacity !== 1) args.push(`fillOpacity: ${fmtNum(piece.fillOpacity)}`);
  if (piece.stroke !== null) {
    const s = piece.stroke;
    const strokeParts = [`tone: .${s.tone}`, `width: ${fmtNum(s.width)}`];
    if (s.opacity !== 1) strokeParts.push(`opacity: ${fmtNum(s.opacity)}`);
    if (s.roundCap) strokeParts.push("roundCap: true");
    if (s.roundJoin) strokeParts.push("roundJoin: true");
    args.push(`stroke: .init(${strokeParts.join(", ")})`);
  }
  if (piece.clipped) args.push("clipped: true");
  if (piece.rotation !== null) {
    const r = piece.rotation;
    args.push(
      `rotate: .init(degrees: ${fmtNum(r.degrees)}, cx: ${fmtNum(r.cx)}, cy: ${fmtNum(r.cy)})`,
    );
  }
  const suffix = args.length > 0 ? `, ${args.join(", ")}` : "";
  if (piece.pathLines.length === 1) {
    return [`${indent}pieces.append(piece({ path in ${piece.pathLines[0]} }${suffix}))`];
  }
  return [
    `${indent}pieces.append(piece({ path in`,
    ...piece.pathLines.map((line) => `${indent}    ${line}`),
    `${indent}}${suffix}))`,
  ];
}

function emitPieces(items: SwiftPiece[], pad: string): string[] {
  return items.flatMap((piece) => emitPieceCall(piece, pad));
}

function emitTieredPieces(byTier: Record<FaceTier, SwiftPiece[]>, indent: string): string[] {
  const { s, m, l } = byTier;
  const sameAt = (si: number, mi: number, li: number) =>
    JSON.stringify(s[si]) === JSON.stringify(m[mi]) &&
    JSON.stringify(m[mi]) === JSON.stringify(l[li]);

  const minLen = Math.min(s.length, m.length, l.length);
  let pre = 0;
  while (pre < minLen && sameAt(pre, pre, pre)) pre++;
  let suf = 0;
  while (suf < minLen - pre && sameAt(s.length - 1 - suf, m.length - 1 - suf, l.length - 1 - suf)) {
    suf++;
  }

  const out = emitPieces(s.slice(0, pre), indent);
  const [ms, mm, ml] = [
    s.slice(pre, s.length - suf),
    m.slice(pre, m.length - suf),
    l.slice(pre, l.length - suf),
  ];
  const [ks, km, kl] = [JSON.stringify(ms), JSON.stringify(mm), JSON.stringify(ml)];
  const inner = `${indent}    `;

  if (ks === km && km === kl) {
    out.push(...emitPieces(ms, indent));
  } else if (km === kl) {
    if (ms.length === 0)
      out.push(`${indent}if tier != .s {`, ...emitPieces(mm, inner), `${indent}}`);
    else if (mm.length === 0)
      out.push(`${indent}if tier == .s {`, ...emitPieces(ms, inner), `${indent}}`);
    else {
      out.push(
        `${indent}if tier == .s {`,
        ...emitPieces(ms, inner),
        `${indent}} else {`,
        ...emitPieces(mm, inner),
        `${indent}}`,
      );
    }
  } else if (ks === km && ms.length === 0) {
    out.push(`${indent}if tier == .l {`, ...emitPieces(ml, inner), `${indent}}`);
  } else {
    out.push(`${indent}switch tier {`);
    for (const [tier, mid] of [
      ["s", ms],
      ["m", mm],
      ["l", ml],
    ] as const) {
      if (mid.length === 0) out.push(`${indent}case .${tier}: break`);
      else out.push(`${indent}case .${tier}:`, ...emitPieces(mid, inner));
    }
    out.push(`${indent}}`);
  }
  out.push(...emitPieces(s.slice(s.length - suf), indent));
  return out;
}

function emitPaletteSwitch(): string[] {
  const lines = [
    "    static func palette(for pair: BotFace.Pair, dark: Bool) -> BotFacePalette {",
    "        switch (pair, dark) {",
  ];
  for (const pair of botFaceFields.pair) {
    for (const scheme of ["light", "dark"] as const) {
      const c = faceColours(pair, scheme);
      const dark = scheme === "dark";
      lines.push(
        `        case (.${pair}, ${dark}): return .init(body: ${hexLiteral(c.body)}, accent: ${hexLiteral(c.accent)}, bodyShade: ${hexLiteral(c.bodyShade)}, accentShade: ${hexLiteral(c.accentShade)}, pale: ${hexLiteral(c.pale)}, visor: ${hexLiteral(c.visor)}, mask: ${hexLiteral(c.mask)}, blush: ${hexLiteral(c.blush)}, tongue: ${hexLiteral(c.tongue)})`,
      );
    }
  }
  lines.push("        }", "    }");
  return lines;
}

function emitEyeMetrics(): string[] {
  const lines = [
    "    static func eye(_ kind: BotFace.Eyes) -> BotFaceEyeMetrics {",
    "        switch kind {",
  ];
  for (const kind of botFaceFields.eyes) {
    const e = botFaceEyes[kind];
    lines.push(
      `        case .${kind}: return .init(dx: ${fmtNum(e.dx)}, rx: ${fmtNum(e.rx)}, ry: ${fmtNum(e.ry)}, lid: ${fmtNum(e.lid)}, dy: ${fmtNum(e.dy)})`,
    );
  }
  lines.push("        }", "    }");
  return lines;
}

function emitBodyMetrics(): string[] {
  const lines = [
    "    static func body(_ kind: BotFace.Body) -> BotFaceBodyMetrics {",
    "        switch kind {",
  ];
  for (const kind of botFaceFields.body) {
    const b = botFaceBodies[kind];
    const lidTone = b.lid === "var(--visor)" ? ".visor" : ".body";
    lines.push(
      `        case .${kind}: return .init(eyeY: ${fmtNum(b.eyeY)}, eyeScale: ${fmtNum(b.eyeScale ?? 1)}, mouthY: ${fmtNum(b.mouthY)}, top: ${fmtPoint({ x: b.top[0], y: b.top[1] })}, left: ${fmtNum(b.left)}, right: ${fmtNum(b.right)}, cheekY: ${fmtNum(b.cheekY)}, cheekDx: ${fmtNum(b.cheekDx)}, light: ${fmtPoint({ x: b.light[0], y: b.light[1] })}, lid: ${lidTone}, hasMouth: ${b.mouth !== "none"})`,
    );
  }
  lines.push("        }", "    }");
  return lines;
}

function emitSilhouettes(): string[] {
  const lines = [
    "    static func silhouette(_ kind: BotFace.Body, tier: BotFaceTier) -> Path {",
    "        var path = Path()",
    "        switch kind {",
  ];
  for (const kind of botFaceFields.body) {
    const b = botFaceBodies[kind];
    const small = svgShapesToSwiftPath(b.shapes("s"));
    const regular = svgShapesToSwiftPath(b.shapes("m"));
    lines.push(`        case .${kind}:`);
    if (JSON.stringify(small) === JSON.stringify(regular)) {
      lines.push(...regular.map((line) => `            ${line}`));
    } else {
      lines.push("            if tier == .s {");
      lines.push(...small.map((line) => `                ${line}`));
      lines.push("            } else {");
      lines.push(...regular.map((line) => `                ${line}`));
      lines.push("            }");
    }
  }
  lines.push("        }", "        return path", "    }");
  return lines;
}

function byTierOf(render: (tier: FaceTier) => string): Record<FaceTier, SwiftPiece[]> {
  return {
    s: svgFragmentToPieces(render("s")),
    m: svgFragmentToPieces(render("m")),
    l: svgFragmentToPieces(render("l")),
  };
}

function emitPieceSwitch(
  signature: string,
  entries: [string, Record<FaceTier, SwiftPiece[]>][],
): string[] {
  const lines = [
    `    static func ${signature} -> [BotFacePiece] {`,
    "        var pieces: [BotFacePiece] = []",
    "        switch kind {",
  ];
  for (const [kind, byTier] of entries) {
    if (byTier.s.length === 0 && byTier.m.length === 0 && byTier.l.length === 0) continue;
    lines.push(`        case .${kind}:`, ...emitTieredPieces(byTier, "            "));
  }
  lines.push("        default: break", "        }", "        return pieces", "    }");
  return lines;
}

function emitBodyLayer(name: "back" | "front" | "over", swiftName: string): string[] {
  const entries: [string, Record<FaceTier, SwiftPiece[]>][] = [];
  for (const kind of botFaceFields.body) {
    const fn = botFaceBodies[kind][name];
    if (fn) entries.push([kind, byTierOf((tier) => fn(tier, "c"))]);
  }
  return emitPieceSwitch(`${swiftName}(_ kind: BotFace.Body, tier: BotFaceTier)`, entries);
}

function emitEarLayer(name: "back" | "inner", swiftName: string): string[] {
  const earKinds = botFaceFields.ears.filter(
    (each): each is Exclude<BotFaceValue<"ears">, "none"> => each !== "none",
  );
  return emitPieceSwitch(
    `${swiftName}(_ kind: BotFace.Ears, tier: BotFaceTier)`,
    earKinds.map((kind) => [kind, byTierOf((tier) => botFaceEars[kind][name](tier))]),
  );
}

function emitStaticMarkings(): string[] {
  const dummyEyes = {
    shape: botFaceEyes.egg,
    tier: "m" as FaceTier,
    pupil: { rx: 1, ry: 1 },
    reach: { x: 1, y: 1 },
    y: 12,
    xs: [8.7, 15.3] as const,
  };
  return emitPieceSwitch(
    "staticMarking(_ kind: BotFace.Marking, tier: BotFaceTier)",
    (["cap", "stripes", "spots"] as const).map((kind) => [
      kind,
      byTierOf((tier) => botFaceMarkings[kind](tier, dummyEyes, botFaceBodies.round)),
    ]),
  );
}

function emitScarf(): string[] {
  const scarfFace = { ...botFaceDefaults, accessory: "scarf" as const };
  const byTier = byTierOf((tier) =>
    botFaceAccessoryMarkup(scarfFace, tierSize[tier], botFaceBodies.round, "front", "c"),
  );
  return [
    "    static func scarf(tier: BotFaceTier) -> [BotFacePiece] {",
    "        var pieces: [BotFacePiece] = []",
    ...emitTieredPieces(byTier, "        "),
    "        return pieces",
    "    }",
  ];
}

const HEADER =
  "// Generated by scripts/generate-bot-faces.ts from @ace/ui-core/bot-face. Do not edit.\n\nimport SwiftUI\n";

/** Builds the three generated Swift files under `Sources/Design/`. */
export function generateBotFaceFiles(): Record<string, string> {
  const palette = [
    HEADER,
    "/// Colour roles a bot face draws with, resolved from the face's pair and light/dark scheme.",
    "enum BotFaceTone: Sendable {",
    "    case body, accent, bodyShade, accentShade, pale, visor, mask, blush, tongue, ink, paper, sweat",
    "}",
    "",
    "/// All nine derived sRGB hex colours for one pair and colour scheme (`ui-core/bot-face/palette.ts`).",
    "struct BotFacePalette: Sendable, Equatable {",
    "    let body: UInt32; let accent: UInt32; let bodyShade: UInt32; let accentShade: UInt32",
    "    let pale: UInt32; let visor: UInt32; let mask: UInt32; let blush: UInt32; let tongue: UInt32",
    "}",
    "",
    "struct BotFaceRotation: Sendable { let degrees: Double; let cx: CGFloat; let cy: CGFloat }",
    "struct BotFaceStroke: Sendable { let tone: BotFaceTone; let width: CGFloat; var opacity: Double = 1; var roundCap = false; var roundJoin = false }",
    "struct BotFacePiece: Sendable { let path: Path; let fill: BotFaceTone?; let fillOpacity: Double; let stroke: BotFaceStroke?; let clipped: Bool; let rotate: BotFaceRotation? }",
    "struct BotFaceEyeMetrics: Sendable, Equatable { let dx: CGFloat; let rx: CGFloat; let ry: CGFloat; let lid: CGFloat; let dy: CGFloat }",
    "struct BotFaceBodyMetrics: Sendable, Equatable {",
    "    let eyeY: CGFloat; let eyeScale: CGFloat; let mouthY: CGFloat",
    "    let top: CGPoint; let left: CGFloat; let right: CGFloat",
    "    let cheekY: CGFloat; let cheekDx: CGFloat; let light: CGPoint",
    "    let lid: BotFaceTone; let hasMouth: Bool",
    "}",
    "",
    "/// Bot face geometry and palettes on the 24 box, generated from `@ace/ui-core/bot-face`.",
    "enum BotFaceGeometry {",
    `    static let tilt: Double = ${fmtNum(botFaceTiltDeg)}`,
    `    static let ink: UInt32 = ${hexLiteral(faceInk)}`,
    `    static let paper: UInt32 = ${hexLiteral(facePaper)}`,
    "    static let sweat: UInt32 = 0xCFE6FF",
    "    static func ring(for tier: BotFaceTier) -> CGFloat {",
    `        switch tier { case .s: ${fmtNum(botFaceRing.s)}; case .m: ${fmtNum(botFaceRing.m)}; case .l: ${fmtNum(botFaceRing.l)} }`,
    "    }",
    "    static func line(for tier: BotFaceTier) -> CGFloat {",
    `        switch tier { case .s: ${fmtNum(botFaceLine.s)}; case .m: ${fmtNum(botFaceLine.m)}; case .l: ${fmtNum(botFaceLine.l)} }`,
    "    }",
    ...emitPaletteSwitch(),
    ...emitEyeMetrics(),
    ...emitBodyMetrics(),
    "    static func piece(_ build: (inout Path) -> Void, fill: BotFaceTone? = nil, fillOpacity: Double = 1, stroke: BotFaceStroke? = nil, clipped: Bool = false, rotate: BotFaceRotation? = nil) -> BotFacePiece {",
    "        var path = Path()",
    "        build(&path)",
    "        return BotFacePiece(path: path, fill: fill, fillOpacity: fillOpacity, stroke: stroke, clipped: clipped, rotate: rotate)",
    "    }",
    "}",
    "",
  ].join("\n");

  const bodies = [
    HEADER,
    "extension BotFaceGeometry {",
    ...emitSilhouettes(),
    ...emitBodyLayer("back", "bodyBack"),
    ...emitBodyLayer("front", "bodyFront"),
    ...emitBodyLayer("over", "bodyOver"),
    "}",
    "",
  ].join("\n");

  const parts = [
    HEADER,
    "extension BotFaceGeometry {",
    ...emitEarLayer("back", "earBack"),
    ...emitEarLayer("inner", "earInner"),
    ...emitStaticMarkings(),
    ...emitScarf(),
    "}",
    "",
  ].join("\n");

  return {
    "BotFacePalette.generated.swift": palette,
    "BotFaceBodies.generated.swift": bodies,
    "BotFaceParts.generated.swift": parts,
  };
}

export const botFaceDesignDir = join(import.meta.dirname, "..", "Sources", "Design");

if (import.meta.main) {
  const files = generateBotFaceFiles();
  const check = process.argv.includes("--check");
  let stale = false;
  for (const [name, swift] of Object.entries(files)) {
    const target = join(botFaceDesignDir, name);
    if (check) {
      const existing = await readFile(target, "utf8").catch(() => "");
      if (existing !== swift) {
        console.error(`${name} is out of date. Run: bun scripts/generate-bot-faces.ts`);
        stale = true;
      }
    } else {
      await writeFile(target, swift);
      console.log(`Wrote ${target}`);
    }
  }
  if (check) {
    if (stale) process.exit(1);
    console.log("Bot face generated Swift files are up to date.");
  }
}
