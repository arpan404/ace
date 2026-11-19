import type { Rolldown } from "vite";
import { describe, expect, test } from "vitest";
import { lazyIconChunk } from "./icon-chunk.ts";

type ModuleInfo = Rolldown.ModuleInfo;

const web = "/repo/apps/web/src";
const thread = `${web}/routes/_home.t.$threadId.tsx?tsr-split=component`;
const icons = "/repo/packages/icons/src";

/** An icon's module in the package. */
const glyph = (name: string) => `${icons}/glyphs/${name.toLowerCase()}.ts`;

/** A small app: the thread page draws a gear and, through its composer, a robot (renamed). */
const modules: Record<string, { code: string; importedIds: string[] }> = {
  [thread]: {
    code: 'import { GearIcon, type Icon } from "@ace/icons";',
    importedIds: [`${web}/routes/composer.tsx`, `${icons}/index.ts`],
  },
  // A feature's barrel: the thread page's composer takes only its card.
  [`${web}/features/home/index.ts`]: {
    code: [
      'export { Card } from "./card.tsx";',
      'export { Picker } from "./picker.tsx";',
      'export { StarIcon as Favourite } from "@ace/icons";',
    ].join("\n"),
    importedIds: [
      `${web}/features/home/card.tsx`,
      `${web}/features/home/picker.tsx`,
      `${icons}/index.ts`,
    ],
  },
  [`${web}/features/home/card.tsx`]: {
    code: 'import { HeartIcon } from "@ace/icons";',
    importedIds: [`${icons}/index.ts`],
  },
  [`${web}/features/home/picker.tsx`]: {
    code: 'import { PaletteIcon } from "@ace/icons";',
    importedIds: [`${icons}/index.ts`],
  },
  // A package barrel through `export *`: a name it doesn't list may come from any of them.
  "/repo/packages/kit/src/index.ts": {
    code: 'export * from "./lead.tsx";\nexport * from "./other.tsx";',
    importedIds: ["/repo/packages/kit/src/lead.tsx", "/repo/packages/kit/src/other.tsx"],
  },
  "/repo/packages/kit/src/lead.tsx": {
    code: 'import { BrainIcon } from "@ace/icons";',
    importedIds: [`${icons}/index.ts`],
  },
  "/repo/packages/kit/src/other.tsx": {
    code: 'import { LeafIcon } from "@ace/icons";',
    importedIds: [`${icons}/index.ts`],
  },
  // A subpath it can't trace to one module is followed whole.
  "/repo/packages/kit/src/tools.ts": {
    code: 'export { Tool } from "./tool.tsx";\nexport { Unused } from "./unused.tsx";',
    importedIds: ["/repo/packages/kit/src/tool.tsx", "/repo/packages/kit/src/unused.tsx"],
  },
  "/repo/packages/kit/src/tool.tsx": {
    code: 'import { WrenchIcon } from "@ace/icons";',
    importedIds: [`${icons}/index.ts`],
  },
  "/repo/packages/kit/src/unused.tsx": {
    code: 'import { HammerIcon } from "@ace/icons";',
    importedIds: [`${icons}/index.ts`],
  },
  [`${web}/routes/composer.tsx`]: {
    code: [
      'import {\n  RobotIcon as Bot,\n} from "@ace/icons";',
      'import { Card } from "@/features/home/index.ts";',
      'import { Lead } from "@ace/kit";',
      'import { Tool } from "@ace/kit/tools";',
      'const later = () => import("./x");',
    ].join("\n"),
    importedIds: [
      `${web}/features/home/index.ts`,
      "/repo/packages/kit/src/index.ts",
      "/repo/packages/kit/src/tools.ts",
      `${icons}/index.ts`,
    ],
  },
  // Only loaded through `import()` from the thread page's code: its icons load with it, later.
  [`${web}/routes/x.tsx`]: {
    code: 'import { RocketIcon } from "@ace/icons";',
    importedIds: [],
  },
  [`${icons}/index.ts`]: {
    code: 'export { RocketIcon } from "./glyphs/rocket.ts";',
    importedIds: [`${icons}/glyphs/rocket.ts`],
  },
  // The package's own modules: one per icon, each importing the shared renderer.
  ...Object.fromEntries(
    [
      "Gear",
      "Robot",
      "Rocket",
      "Heart",
      "Palette",
      "Star",
      "Brain",
      "Leaf",
      "Wrench",
      "Hammer",
    ].map((name) => [
      glyph(name),
      {
        code: `import { glyph } from "../glyph.ts";\nexport const ${name}Icon = /* @__PURE__ */ glyph("${name}", () => []);`,
        importedIds: [`${icons}/glyph.ts`],
      },
    ]),
  ),
  [`${icons}/glyph.ts`]: { code: "export function glyph() {}", importedIds: [] },
};

/** The module graph as the bundler reports it; the group reads only code and static imports. */
function getModuleInfo(module: string): ModuleInfo | null {
  const found = modules[module];
  return found ? ({ ...found, id: module } as ModuleInfo) : null;
}

function chunkOf(id: string) {
  const name = lazyIconChunk(thread).name;
  return typeof name === "function" ? name(id, { getModuleInfo }) : name;
}

describe("the shared icon chunks", () => {
  test("give the icons the thread page statically draws a chunk of their own", () => {
    expect(chunkOf(glyph("Gear"))).toBe("icons-thread");
    expect(chunkOf(glyph("Robot"))).toBe("icons-thread");
  });

  test("keep icons other pages or later imports draw in the shared chunk", () => {
    expect(chunkOf(glyph("Rocket"))).toBe("icons");
    expect(chunkOf(`${icons}/glyph.ts`)).toBe("icons");
  });

  test("count only the modules a barrel's imported names come from", () => {
    expect(chunkOf(glyph("Heart"))).toBe("icons-thread");
    expect(chunkOf(glyph("Palette"))).toBe("icons");
    // An icon the barrel re-exports counts only when a page takes it.
    expect(chunkOf(glyph("Star"))).toBe("icons");
  });

  test("follow every module an export-all barrel or an untraced import could bring", () => {
    expect(chunkOf(glyph("Brain"))).toBe("icons-thread");
    expect(chunkOf(glyph("Leaf"))).toBe("icons-thread");
    expect(chunkOf(glyph("Wrench"))).toBe("icons-thread");
    expect(chunkOf(glyph("Hammer"))).toBe("icons-thread");
  });

  test("keep every icon in the shared chunk when the thread page is not in the build", () => {
    const name = lazyIconChunk(`${web}/routes/missing.tsx`).name;
    const chunk =
      typeof name === "function" ? name(glyph("Gear"), { getModuleInfo: () => null }) : name;
    expect(chunk).toBe("icons");
  });
});
