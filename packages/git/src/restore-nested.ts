import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { nestedPaths } from "./nested.ts";
import { parseIndex, parseTree } from "./parse-index.ts";
import { transferTree } from "./object-transfer.ts";
import { serial } from "./lock.ts";
import { withIndex } from "./temporary-index.ts";
import { malformed } from "./decode.ts";
import type { Repository } from "./repository.ts";

// Each child owns its filter configuration. Recheck out its flattened subtree
// through that repository, while keeping its real index and references intact.
export async function restoreNested(
  repository: Repository,
  root: string,
  tree: string,
): Promise<void> {
  const tracked = parseIndex(
    (await repository.cli.call(root, ["ls-files", "--stage", "-z"])).stdout,
  );
  for (const path of await nestedPaths(repository, root, tracked)) {
    const entries = parseTree(
      (await repository.cli.call(root, ["ls-tree", "-z", tree, "--", `:(literal)${path}`])).stdout,
    );
    if (!entries.length) continue;
    const [entry] = entries;
    if (entries.length !== 1 || !entry || entry.path !== path)
      throw malformed("nested restore subtree");
    if (entry.type !== "tree") continue;
    const nested = await realpath(join(root, path));
    await serial(nested, async () => {
      await transferTree(repository, root, nested, entry.sha);
      await withIndex(repository.tempDirectory, async (env) => {
        await repository.cli.call(nested, ["read-tree", entry.sha], { write: true, env });
        await repository.cli.call(nested, ["checkout-index", "--all", "--force"], {
          write: true,
          env,
        });
      });
      await restoreNested(repository, nested, entry.sha);
    });
  }
}
