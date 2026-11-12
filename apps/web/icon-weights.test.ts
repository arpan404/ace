import { describe, expect, test } from "vitest";
import { strayWeights, tableWeights } from "./icon-weights.ts";

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

test("a module asking for a weight the build drops is named, unless it is a glyph table", () => {
  expect(
    strayWeights(
      new Map([
        ["src/components/empty-glyphs.ts", 'pinnedGlyph(WarningCircleIcon, ["duotone"])'],
        [
          "src/components/ace-icons.tsx",
          'const solid = weight === "fill" || weight === "duotone";',
        ],
        ["src/features/home/empty.tsx", '<FolderIcon weight="duotone" />'],
        ["src/features/home/row.tsx", "<FolderIcon weight='thin' />"],
        ["src/features/home/list.tsx", '<FolderIcon weight="bold" />'],
      ]),
    ),
  ).toEqual(["src/features/home/empty.tsx", "src/features/home/row.tsx"]);
});
