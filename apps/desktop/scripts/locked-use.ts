import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LockedUseManifest, lockedUseFiles } from "../src/packaging/locked-use.ts";

/** Build/sign only: installation remains a separate owner action in Settings. */
export async function stageLockedUse(repo: string, destination: string): Promise<void> {
  const source = join(repo, "native/locked-use");
  execFileSync("sh", [join(source, "build.sh")], { cwd: repo, stdio: "inherit" });
  await mkdir(destination, { recursive: true });
  for (const name of Object.values(lockedUseFiles))
    await cp(join(source, "build", name), join(destination, name), { recursive: true });
  const manifest = LockedUseManifest.parse({
    team: (await readFile(join(source, "build/team"), "utf8")).trim(),
  });
  await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest) + "\n");
}
