import { describe, expect, test } from "vitest";
import { weightProblems } from "./icon-weight-guard.ts";
import { tableWeights } from "./icon-weights.ts";

const tables = {
  "src/file-icon.ts": ["regular"],
  "src/project-glyphs.ts": ["regular", "bold"],
  "src/empty-glyphs.ts": ["duotone"],
};
const base = ["regular", "fill", "bold"];
const weightsOf = (sources: Record<string, string>, icon?: string) => {
  const kept = tableWeights(new Map(Object.entries(sources)), tables, base);
  if (icon) return [...(kept.weights.get(icon) ?? kept.fallback)].toSorted();
  return Object.fromEntries(
    [...kept.weights].map(([name, weights]) => [name, [...weights].toSorted()]),
  );
};

describe("which weights an icon drawn only by glyph tables keeps", () => {
  test("a mark only one table draws keeps that table's weights", () => {
    expect(
      weightsOf({
        "src/file-icon.ts":
          'import {\n  FileCssIcon,\n  FileTsIcon,\n} from "@phosphor-icons/react";',
        "src/project-glyphs.ts": 'import { RocketIcon, type Icon } from "@phosphor-icons/react";',
      }),
    ).toEqual({ FileCss: ["regular"], FileTs: ["regular"], Rocket: ["bold", "regular"] });
  });

  test("a mark both tables draw keeps the weights of both", () => {
    expect(
      weightsOf({
        "src/file-icon.ts": 'import { CodeIcon } from "@phosphor-icons/react";',
        "src/project-glyphs.ts": 'import { CodeIcon } from "@phosphor-icons/react";',
      }),
    ).toEqual({ Code: ["bold", "regular"] });
  });

  test("a mark anything else imports or re-exports keeps every weight icons are drawn in", () => {
    const sources = {
      "src/file-icon.ts": 'import { FileCssIcon, GearIcon } from "@phosphor-icons/react";',
      "src/settings.tsx": 'import { GearIcon, StarIcon } from "@phosphor-icons/react";',
      "../../packages/kit/src/index.ts":
        'export { FileCssIcon as Css } from "@phosphor-icons/react";',
    };
    for (const icon of ["Gear", "FileCss", "Star"])
      expect(weightsOf(sources, icon)).toEqual(["bold", "fill", "regular"]);
  });

  test("an empty state's glyph keeps duotone beside the weights others draw it in", () => {
    const sources = {
      "src/empty-glyphs.ts": 'import { WarningCircleIcon } from "@phosphor-icons/react";',
      "src/notice.tsx": 'import { WarningCircleIcon, XIcon } from "@phosphor-icons/react";',
    };
    expect(weightsOf(sources, "WarningCircle")).toEqual(["bold", "duotone", "fill", "regular"]);
    expect(weightsOf(sources, "X")).toEqual(["bold", "fill", "regular"]);
  });

  test("a module reaching Phosphor some other way leaves every icon every weight", () => {
    for (const other of [
      'import * as icons from "@phosphor-icons/react";',
      'export * from "@phosphor-icons/react";',
      'import { FileCss } from "@phosphor-icons/react/dist/csr/FileCss";',
      'const icons = await import("@phosphor-icons/react");',
    ])
      expect(
        weightsOf(
          {
            "src/file-icon.ts": 'import { FileCssIcon } from "@phosphor-icons/react";',
            "src/other.ts": other,
          },
          "FileCss",
        ),
      ).toEqual(["bold", "duotone", "fill", "regular"]);
  });
});

/** What the build keeps: every icon's weights, and duotone in the empty-state table. */
const kept = (path: string) =>
  new Set(["regular", "fill", "bold", ...(path === "src/empty-glyphs.ts" ? ["duotone"] : [])]);

/** The lines `weightProblems` names in one module of `code`. */
const problems = (code: string, path = "src/features/home/row.tsx") =>
  weightProblems(
    new Map([[path, `import { GearIcon } from "@phosphor-icons/react";\n${code}`]]),
    kept,
  );

describe("places that ask an icon for a weight the build may drop", () => {
  test("weights spelled out as kept weights, or chosen between them, pass", () => {
    expect(
      problems(
        [
          'export const A = () => <GearIcon weight="bold" />;',
          'export const B = (p) => <GearIcon weight={p.on ? "fill" : "regular"} />;',
          'export const C = (p) => <GearIcon weight={p.on ? `fill` : "regular"} />;',
          'export const D = { icon: GearIcon, weight: "fill" as const };',
          // A cache's byte weight is no icon's.
          "export const E = { weight: (entry) => entry.bytes };",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("a dropped weight is named, spelled out, chosen, or under a quoted key", () => {
    expect(
      problems(
        [
          'export const A = () => <GearIcon weight="duotone" />;',
          'export const B = (p) => <GearIcon weight={p.compact ? "light" : "regular"} />;',
          'export const C = { icon: GearIcon, "weight": "thin" };',
        ].join("\n"),
      ),
    ).toEqual([
      'src/features/home/row.tsx:2 asks an icon for "duotone", a weight the build drops',
      'src/features/home/row.tsx:3 asks an icon for "light", a weight the build drops',
      'src/features/home/row.tsx:4 asks an icon for "thin", a weight the build drops',
    ]);
  });

  test("a weight from a variable or a call, or props spread onto an icon, can't be read and is named", () => {
    expect(
      problems(
        [
          'const w = compact ? "light" : "regular";',
          "export const A = () => <GearIcon weight={w} />;",
          "export const B = () => <GearIcon weight={pick()} />;",
          "export const C = (props) => <GearIcon size={16} {...props} />;",
        ].join("\n"),
      ),
    ).toEqual([
      "src/features/home/row.tsx:3 sets <GearIcon>'s weight to a value the source doesn't spell out",
      "src/features/home/row.tsx:4 sets <GearIcon>'s weight to a value the source doesn't spell out",
      "src/features/home/row.tsx:5 spreads props onto <GearIcon>, so its weight can't be read",
    ]);
  });

  test("a glyph table may draw its own weight, and a typed module may pass one along", () => {
    expect(
      problems('export const A = { icon: GearIcon, weight: "duotone" };', "src/empty-glyphs.ts"),
    ).toEqual([]);
    expect(
      problems(
        "export const A = (p) => <GearIcon {...p} weight={p.weight} />;",
        "src/components/icon.tsx",
      ),
    ).toEqual([]);
  });
});
