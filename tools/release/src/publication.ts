import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { verifyManifest, hashFile, installableVersion } from "@ace/service";
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
for (const target of ReleaseTarget.options) {
  const bytes = await readFile(join(directory, `${target}.json`));
  const signature = (await readFile(join(directory, `${target}.sig`), "utf8")).trim();
  const m = verifyManifest(bytes, signature, key);
  installableVersion(m.version);
  if (m.target !== target || (await hashFile(join(directory, m.archive))) !== m.sha256)
    throw new Error("Publication artifact mismatch");
  await validateReleaseArchive(join(directory, m.archive));
  manifests.set(target, m);
}
const version = manifests.get("darwin-arm64")?.version;
if (!version || [...manifests.values()].some((m) => m.version !== version))
  throw new Error("Publication versions differ");
const source = resolve(import.meta.dirname, "..");
let installer = (await readFile(join(source, "install.sh"), "utf8"))
  .replace("__ACE_RELEASE_PUBLIC_KEY__", key.trim())
  .replace("__ACE_RELEASE_BASE_URL__", base);
for (const [target, m] of manifests)
  installer = installer.replace(
    `__ACE_${target.replace("-", "_").toUpperCase()}_SHA256__`,
    m.sha256,
  );
await writeFile(join(directory, "install.sh"), installer, { mode: 0o755 });
let formula = (await readFile(join(source, "homebrew/ace.rb.in"), "utf8"))
  .replaceAll("@VERSION@", version)
  .replaceAll("@BASE@", base);
for (const [target, m] of manifests)
  formula = formula.replace(`@${target.replace("-", "_").toUpperCase()}_SHA256@`, m.sha256);
await mkdir(join(directory, "homebrew"), { recursive: true });
await writeFile(join(directory, "homebrew/ace.rb"), formula);
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
process.stdout.write(`Installer SHA-256: ${digest}\nReview and publish these files together.\n`);
