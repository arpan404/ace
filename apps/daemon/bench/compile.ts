import { bundleDaemon } from "../../../tools/release/src/bundle.ts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { stageNodeRuntime, nodeVersion } from "../../../tools/release/src/node-runtime.ts";
import { ReleaseTarget } from "@ace/protocol";
const repo = resolve(import.meta.dirname, "../../..");
const root = resolve(
  repo,
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ?? ".ace-dev/perf-bundle",
);
await mkdir(root, { recursive: true });
await bundleDaemon(
  repo,
  root,
  "",
  undefined,
  process.argv.includes("--cli") ? undefined : resolve(import.meta.dirname, "entry.ts"),
);
if (process.argv.includes("--runtime")) {
  const cacheDir = resolve(repo, ".ace-dev/node-cache");
  await mkdir(cacheDir, { recursive: true });
  await stageNodeRuntime({
    target: ReleaseTarget.parse(`${process.platform}-${process.arch}`),
    version: nodeVersion,
    cacheDir,
    destination: root,
  });
}
process.stdout.write(`${root}/ace.mjs\n`);
