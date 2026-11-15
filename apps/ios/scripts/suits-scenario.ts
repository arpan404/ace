import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { FakeDaemon, FakeSuitFolder } from "@ace/fake-daemon";

/*
 * The Suits ace ships (Tarn and Mizzle), read from `@ace/plugins`' own folders, plus one that
 * fails its checks, so the phone's Look grid shows Suits it can wear and one it can't.
 */

const shipped = fileURLToPath(new URL("../../../packages/plugins/builtin-suits", import.meta.url));

function folder(root: string, id: string): FakeSuitFolder {
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path)] = readFileSync(path);
    }
  };
  walk(root);
  return { id, files };
}

export function seedSuits(daemon: FakeDaemon): void {
  const ids = readdirSync(shipped).filter((name) => statSync(join(shipped, name)).isDirectory());
  const broken: FakeSuitFolder = {
    id: "static",
    files: {
      "suit.json": JSON.stringify({
        format: 1,
        id: "static",
        name: "Static",
        description: "Grey on grey: it fails the contrast checks.",
        light: { canvas: "#FFFFFF", text: "#F4F4F4", muted: "#F4F4F4" },
      }),
    },
  };
  daemon.suits.set([...ids.map((id) => folder(join(shipped, id), id)), broken]);
}
