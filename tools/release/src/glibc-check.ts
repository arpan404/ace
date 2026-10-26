import { resolve } from "node:path";
import { assertLinuxRuntimeFloor, describe, elfFiles, linuxRuntimeFloor } from "./glibc.ts";

/**
 * `node tools/release/src/glibc-check.ts DIR...`: lists the newest glibc and libstdc++ symbol
 * version every ELF file under DIR needs, and fails when any is above the release floor
 * other than the reviewed exceptions (`knownAboveFloor`).
 */
const roots = process.argv.slice(2).map((path) => resolve(path));
if (!roots.length) throw new Error("Usage: glibc-check DIR [DIR...]");
const elves = await elfFiles(roots);
for (const { path, needs } of elves) process.stdout.write(`${describe(needs)}\t${path}\n`);
process.stdout.write(
  `${elves.length} ELF files; floor glibc ${linuxRuntimeFloor.glibc}, GLIBCXX ${linuxRuntimeFloor.glibcxx}\n`,
);
for (const known of await assertLinuxRuntimeFloor(roots))
  process.stdout.write(`Reviewed exception: ${known.path}: ${known.reason}\n`);
process.stdout.write("Everything else is within the floor\n");
