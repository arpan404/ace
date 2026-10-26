import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { verifyManifest, hashFile } from "@ace/service";
import { ReleaseTarget } from "@ace/protocol";
import { validateReleaseArchive } from "./archive.ts";
import { createNpxPackage } from "./npx-package.ts";
const [directory, base, keyFile] = process.argv.slice(2);
if (!directory || !base || !keyFile)
  throw new Error("Usage: publication DIST HTTPS_RELEASE_URL PUBLIC_KEY");
z.string()
  .regex(/^https:\/\/github\.com\/arpan404\/ace\/releases\/download\/[a-zA-Z0-9.-]+$/)
  .parse(base);
const key = await readFile(keyFile, "utf8");
const manifests = new Map<string, ReturnType<typeof verifyManifest>>();
// Any non-empty subset of targets publishes (Linux can ship before macOS is signed). A target
// is present when its manifest exists, and then it must carry a valid signature and archive.
for (const target of ReleaseTarget.options) {
  if (!(await exists(join(directory, `${target}.json`)))) continue;
  const bytes = await readFile(join(directory, `${target}.json`));
  const signature = (await readFile(join(directory, `${target}.sig`), "utf8")).trim();
  const m = verifyManifest(bytes, signature, key);
  if (m.target !== target || (await hashFile(join(directory, m.archive))) !== m.sha256)
    throw new Error("Publication artifact mismatch");
  await validateReleaseArchive(join(directory, m.archive));
  manifests.set(target, m);
}
const version = manifests.values().next().value?.version;
if (!version) throw new Error("No release target to publish: expected TARGET.json and TARGET.sig");
if ([...manifests.values()].some((m) => m.version !== version))
  throw new Error("Publication versions differ");
const source = resolve(import.meta.dirname, "..");
let installer = (await readFile(join(source, "install.sh"), "utf8"))
  .replace("__ACE_RELEASE_PUBLIC_KEY__", key.trim())
  .replace("__ACE_RELEASE_BASE_URL__", base);
// A target this release lacks gets an empty pin, which the installer refuses by name.
for (const target of ReleaseTarget.options)
  installer = installer.replace(
    `__ACE_${target.replace("-", "_").toUpperCase()}_SHA256__`,
    manifests.get(target)?.sha256 ?? "",
  );
await writeFile(join(directory, "install.sh"), installer, { mode: 0o755 });
// The Homebrew formula names every target's archive, so only a full release writes it.
if (manifests.size === ReleaseTarget.options.length) {
  let formula = (await readFile(join(source, "homebrew/ace.rb.in"), "utf8"))
    .replaceAll("@VERSION@", version)
    .replaceAll("@BASE@", base);
  for (const [target, m] of manifests)
    formula = formula.replace(`@${target.replace("-", "_").toUpperCase()}_SHA256@`, m.sha256);
  await mkdir(join(directory, "homebrew"), { recursive: true });
  await writeFile(join(directory, "homebrew/ace.rb"), formula);
}
const digest = await hashFile(join(directory, "install.sh"));
await writeFile(join(directory, "install.sh.sha256"), `${digest}  install.sh\n`);
const npx = [];
for (const manifest of manifests.values()) npx.push(await createNpxPackage(directory, manifest));
await writeFile(
  join(directory, "npx.json"),
  JSON.stringify(
    npx.map((artifact) => ({
      target: artifact.target,
      file: artifact.file,
      sha256: artifact.sha256,
      command: `npx --yes ${base}/${artifact.file} --help`,
    })),
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  `Targets: ${[...manifests.keys()].join(", ")}\nInstaller SHA-256: ${digest}\nReview and publish these files together.\n`,
);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
