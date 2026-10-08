import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FilesService } from "@ace/files";

/** Reserve staged and exported bytes until a complete artifact has been registered. */
export async function publishArtifact(
  files: FilesService,
  root: string,
  input: {
    size: number;
    path: string;
    name: string;
    category: "output" | "support";
    id?: string;
    write(temporary: string): Promise<void>;
  },
  assertAuthorized: () => void,
) {
  const release = files.reserveArtifactExport(input.size);
  const temporary = join(root, `.export-${input.path}`);
  const destination = join(root, input.path);
  let published = false;
  try {
    await input.write(temporary);
    assertAuthorized();
    await rename(temporary, destination);
    const id = await files.registerArtifact({
      root,
      path: input.path,
      name: input.name.slice(0, 256),
      category: input.category,
      ...(input.id ? { id: input.id } : {}),
    });
    published = true;
    return id;
  } finally {
    release();
    await rm(temporary, { force: true });
    if (!published) await rm(destination, { force: true });
  }
}
