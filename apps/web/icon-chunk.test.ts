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
    importedIds: [`${web}/composer.tsx`, `${icons}/index.es.js`],
  },
  [`${web}/composer.tsx`]: {
    code: 'import {\n  RobotIcon as Bot,\n} from "@phosphor-icons/react";\nconst later = () => import("./x");',
    importedIds: [`${icons}/index.es.js`],
  },
  // Only loaded through `import()` from the thread page's code: its icons load with it, later.
  [`${web}/x.tsx`]: {
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

  test("keep every icon in the shared chunk when the thread page is not in the build", () => {
    const name = lazyIconChunk(`${web}/routes/missing.tsx`).name;
    const chunk =
      typeof name === "function"
        ? name(`${icons}/defs/Gear.es.js`, { getModuleInfo: () => null })
        : name;
    expect(chunk).toBe("icons");
  });
});
