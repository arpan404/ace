import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sourceFingerprint, withManifest, checkFingerprint } from "./fingerprint.ts";
import {
  protocolCatalog,
  convertSchemas,
  renderReference,
  writeFiles,
  compareSnapshots,
  readSnapshot,
  canonical,
} from "./index.ts";

const argumentsSchema = z.union([
  z.tuple([]),
  z.tuple([z.literal("--check")]),
  z.tuple([z.literal("--snapshot"), z.literal("--output"), z.string().min(1)]),
  z.tuple([z.literal("--compat"), z.literal("--baseline"), z.string().min(1)]),
]);
try {
  const args = argumentsSchema.parse(process.argv.slice(2));
  const catalog = protocolCatalog();
  const snapshot = convertSchemas(catalog.entries);
  if (args[0] === "--snapshot") {
    await writeFile(args[2], canonical(snapshot));
    console.log(`Wrote release snapshot ${args[2]}`);
  } else if (args[0] === "--compat") {
    const changes = compareSnapshots(await readSnapshot(args[2]), snapshot);
    console.log(canonical(changes).trimEnd());
    if (changes.some((change) => change.kind !== "additive")) process.exitCode = 1;
  } else {
    const root = fileURLToPath(new URL("../../../docs/protocol/", import.meta.url));
    const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const input = await sourceFingerprint(sourceRoot, snapshot, catalog.tools);
    if (args[0] === "--check") {
      const stale = await checkFingerprint(root, input);
      if (stale.length)
        throw new Error(
          `Stale protocol reference: ${stale.join(", ")}. Run bun run docs:protocol.`,
        );
      console.log("Protocol reference is current");
    } else {
      const files = withManifest(renderReference(catalog.entries, catalog.tools, snapshot), input);
      await writeFiles(root, files);
      console.log(`Generated ${files.size} protocol reference files`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
