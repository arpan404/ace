import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { inspectPackage, materializeProjection, projectPlugins, limits } from "../src/index.ts";
import type { Provider } from "../src/index.ts";
import { fixture, sampleFiles, sampleManifest, writeFiles, git } from "../src/test-support.ts";

const f = await fixture({ ...sampleFiles, "assets/large.bin": "x".repeat(limits.file) });
try {
  await f.manager.accept(await f.prepare());
  const snapshots = await f.manager.installed();
  const providers: Provider[] = ["claude", "codex", "opencode", "cursor", "acp", "antigravity"];
  for (const provider of providers) {
    const root = join(f.root, provider);
    const count = 5000;
    const start = performance.now();
    let generated = 0;
    for (let index = 0; index < count; index++)
      generated += projectPlugins(provider, snapshots, { root }).files.length;
    const milliseconds = performance.now() - start;
    console.log(
      JSON.stringify({
        operation: `project-${provider}`,
        opsPerSecond: Math.round((count * 1000) / milliseconds),
        microsecondsPerOp: Math.round((milliseconds * 1000) / count),
        generated,
      }),
    );
  }
  const snapshot = snapshots[0];
  if (!snapshot) throw new Error("Missing benchmark plugin");
  const count = 20;
  const start = performance.now();
  for (let index = 0; index < count; index++) await inspectPackage(snapshot.root);
  console.log(
    JSON.stringify({
      operation: "verify-4MiB",
      opsPerSecond: Math.round((count * 1000) / (performance.now() - start)),
    }),
  );
  const root = join(f.root, "materialize");
  const projection = projectPlugins("claude", snapshots, { root });
  const writeStart = performance.now();
  for (let index = 0; index < 5; index++) await materializeProjection(projection, { root });
  console.log(
    JSON.stringify({
      operation: "materialize-4MiB",
      millisecondsPerOp: Math.round((performance.now() - writeStart) / 5),
      peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    }),
  );
  const extraFiles: Record<string, string> = {};
  const skills = Array.from({ length: 128 }, (_, index) => {
    const name = `skill-${index}`;
    const path = `skills/${name}`;
    extraFiles[`${path}/SKILL.md`] =
      `---\nname: ${name}\ndescription: Benchmark\n---\nReview code.`;
    extraFiles[`${path}/reference.md`] = "Reference";
    return { name, path };
  });
  extraFiles["ace-plugin.json"] = JSON.stringify({ ...sampleManifest, skills });
  await writeFiles(join(f.repo, "plugins/sample"), extraFiles);
  await git(f.repo, ["add", "."]);
  await git(f.repo, ["commit", "-m", "many skills"]);
  await f.manager.accept(await f.manager.update("sample"));
  const many = await f.manager.installed();
  const manyStart = performance.now();
  for (let index = 0; index < 1000; index++)
    projectPlugins("claude", many, { root: join(f.root, "many") });
  console.log(
    JSON.stringify({
      operation: "project-128-skills",
      peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
      microsecondsPerOp: Math.round(performance.now() - manyStart),
    }),
  );
} finally {
  await f.close();
}
