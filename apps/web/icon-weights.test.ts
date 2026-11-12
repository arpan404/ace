import { describe, expect, test } from "vitest";
import { tableWeights } from "./icon-weights.ts";

const tables = { "src/file-icon.ts": ["regular"], "src/project-glyphs.ts": ["regular", "bold"] };
const weightsOf = (sources: Record<string, string>) =>
  Object.fromEntries(
    [...tableWeights(new Map(Object.entries(sources)), tables)].map(([icon, weights]) => [
      icon,
      [...weights].toSorted(),
    ]),
  );

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

  test("a mark anything else imports or re-exports keeps every weight", () => {
    expect(
      weightsOf({
        "src/file-icon.ts": 'import { FileCssIcon, GearIcon } from "@phosphor-icons/react";',
        "src/settings.tsx": 'import { GearIcon } from "@phosphor-icons/react";',
        "../../packages/kit/src/index.ts":
          'export { FileCssIcon as Css } from "@phosphor-icons/react";',
      }),
    ).toEqual({});
  });

  test("a module reaching Phosphor some other way leaves every icon whole", () => {
    for (const other of [
      'import * as icons from "@phosphor-icons/react";',
      'export * from "@phosphor-icons/react";',
      'import { FileCss } from "@phosphor-icons/react/dist/csr/FileCss";',
      'const icons = await import("@phosphor-icons/react");',
    ])
      expect(
        weightsOf({
          "src/file-icon.ts": 'import { FileCssIcon } from "@phosphor-icons/react";',
          "src/other.ts": other,
        }),
      ).toEqual({});
  });
});
