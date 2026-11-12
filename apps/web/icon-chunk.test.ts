import type { Rolldown } from "vite";
import { describe, expect, test } from "vitest";
import { lazyIconChunk } from "./icon-chunk.ts";

type ModuleInfo = Rolldown.ModuleInfo;

const web = "/repo/apps/web/src";
const thread = `${web}/routes/_home.t.$threadId.tsx?tsr-split=component`;
const icons = "/repo/node_modules/@phosphor-icons/react/dist";

/** A small app: the thread page draws a gear and, through its composer, a robot (renamed). */
const modules: Record<string, { code: string; importedIds: string[] }> = {
  [thread]: {
    code: 'import { GearIcon, type Icon } from "@phosphor-icons/react";',
    importedIds: [`${web}/routes/composer.tsx`, `${icons}/index.es.js`],
  },
  // A feature's barrel: the thread page's composer takes only its card.
  [`${web}/features/home/index.ts`]: {
    code: [
      'export { Card } from "./card.tsx";',
      'export { Picker } from "./picker.tsx";',
      'export { StarIcon as Favourite } from "@phosphor-icons/react";',
    ].join("\n"),
    importedIds: [
      `${web}/features/home/card.tsx`,
      `${web}/features/home/picker.tsx`,
      `${icons}/index.es.js`,
    ],
  },
  [`${web}/features/home/card.tsx`]: {
    code: 'import { HeartIcon } from "@phosphor-icons/react";',
    importedIds: [`${icons}/index.es.js`],
  },
  [`${web}/features/home/picker.tsx`]: {
    code: 'import { PaletteIcon } from "@phosphor-icons/react";',
    importedIds: [`${icons}/index.es.js`],
  },
  // A package barrel through `export *`: a name it doesn't list may come from any of them.
  "/repo/packages/kit/src/index.ts": {
    code: 'export * from "./lead.tsx";\nexport * from "./other.tsx";',
    importedIds: ["/repo/packages/kit/src/lead.tsx", "/repo/packages/kit/src/other.tsx"],
  },
  "/repo/packages/kit/src/lead.tsx": {
    code: 'import { BrainIcon } from "@phosphor-icons/react";',
    importedIds: [`${icons}/index.es.js`],
  },
  "/repo/packages/kit/src/other.tsx": {
    code: 'import { LeafIcon } from "@phosphor-icons/react";',
    importedIds: [`${icons}/index.es.js`],
  },
  // A subpath it can't trace to one module is followed whole.
  "/repo/packages/kit/src/tools.ts": {
    code: 'export { Tool } from "./tool.tsx";\nexport { Unused } from "./unused.tsx";',
    importedIds: ["/repo/packages/kit/src/tool.tsx", "/repo/packages/kit/src/unused.tsx"],
  },
  "/repo/packages/kit/src/tool.tsx": {
    code: 'import { WrenchIcon } from "@phosphor-icons/react";',
    importedIds: [`${icons}/index.es.js`],
  },
  "/repo/packages/kit/src/unused.tsx": {
    code: 'import { HammerIcon } from "@phosphor-icons/react";',
    importedIds: [`${icons}/index.es.js`],
  },
  [`${web}/routes/composer.tsx`]: {
    code: [
      'import {\n  RobotIcon as Bot,\n} from "@phosphor-icons/react";',
      'import { Card } from "@/features/home/index.ts";',
      'import { Lead } from "@ace/kit";',
      'import { Tool } from "@ace/kit/tools";',
      'const later = () => import("./x");',
    ].join("\n"),
    importedIds: [
      `${web}/features/home/index.ts`,
      "/repo/packages/kit/src/index.ts",
      "/repo/packages/kit/src/tools.ts",
      `${icons}/index.es.js`,
    ],
  },
  // Only loaded through `import()` from the thread page's code: its icons load with it, later.
  [`${web}/routes/x.tsx`]: {
    code: 'import { RocketIcon } from "@phosphor-icons/react";',
    importedIds: [],
  },
  [`${icons}/index.es.js`]: {
    code: 'export { RocketIcon } from "./csr/Rocket.es.js";',
    importedIds: [`${icons}/csr/Rocket.es.js`],
  },
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
    expect(chunkOf(`${icons}/csr/Gear.es.js`)).toBe("icons-thread");
    expect(chunkOf(`${icons}/defs/Gear.es.js`)).toBe("icons-thread");
    expect(chunkOf(`${icons}/defs/Robot.es.js`)).toBe("icons-thread");
  });

  test("keep icons other pages or later imports draw in the shared chunk", () => {
    expect(chunkOf(`${icons}/defs/Rocket.es.js`)).toBe("icons");
    expect(chunkOf(`${icons}/lib/IconBase.es.js`)).toBe("icons");
  });

  test("count only the modules a barrel's imported names come from", () => {
    expect(chunkOf(`${icons}/defs/Heart.es.js`)).toBe("icons-thread");
    expect(chunkOf(`${icons}/defs/Palette.es.js`)).toBe("icons");
    // An icon the barrel re-exports counts only when a page takes it.
    expect(chunkOf(`${icons}/defs/Star.es.js`)).toBe("icons");
  });

  test("follow every module an export-all barrel or an untraced import could bring", () => {
    expect(chunkOf(`${icons}/defs/Brain.es.js`)).toBe("icons-thread");
    expect(chunkOf(`${icons}/defs/Leaf.es.js`)).toBe("icons-thread");
    expect(chunkOf(`${icons}/defs/Wrench.es.js`)).toBe("icons-thread");
    expect(chunkOf(`${icons}/defs/Hammer.es.js`)).toBe("icons-thread");
  });

  test("keep every icon in the shared chunk when the thread page is not in the build", () => {
    const name = lazyIconChunk(`${web}/routes/missing.tsx`).name;
    const chunk =
      typeof name === "function"
        ? name(`${icons}/defs/Gear.es.js`, { getModuleInfo: () => null })
        : name;
    expect(chunk).toBe("icons");
  });
});
