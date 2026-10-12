import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../../..");
const sources = [
  "apps/web",
  ...["client", "client-worker", "client-react", "ui-core", "fake-daemon"].map(
    (name) => `packages/${name}`,
  ),
];

test.each(["stale reference", "Node import"])(
  "the CI check recipe refuses a %s at its command boundary",
  async (defect) => {
    const directory = await mkdtemp(join(tmpdir(), "ace-ci-gates-"));
    try {
      const parsed = await execute("bun", [
        "-e",
        "console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text()).jobs.check.steps))",
        join(repository, ".github/workflows/check.yml"),
      ]);
      const steps = z
        .array(z.object({ run: z.string().optional() }))
        .parse(JSON.parse(parsed.stdout));
      // Substitute unrelated CI tools at the subprocess boundary. The two defect
      // detectors execute their real public APIs against this disposable workspace.
      const bin = join(directory, "bin");
      await mkdir(bin);
      await mkdir(join(directory, "docs/protocol"), { recursive: true });
      await writeFile(join(directory, "docs/protocol/README.md"), "current\n");
      for (const source of sources)
        await mkdir(join(directory, source, "src"), { recursive: true });
      await writeFile(
        join(directory, "packages/client/src/entry.ts"),
        "export const portable = true;",
      );
      const config = join(directory, "deps.cjs");
      await writeFile(
        config,
        `const config=require(${JSON.stringify(join(repository, ".dependency-cruiser.cjs"))});config.options.webpackConfig.fileName=${JSON.stringify(join(repository, "scripts/depcruise-resolve.cjs"))};module.exports=config;`,
      );
      await writeFile(
        join(bin, "bun"),
        `#!${process.execPath}

import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args.join(' ')==='run docs:protocol --check') {
 const {checkFiles}=await import(${JSON.stringify(pathToFileURL(join(repository, "tools/protocol-docs/src/index.ts")).href)});
 const stale=await checkFiles(${JSON.stringify(join(directory, "docs/protocol"))},new Map([['README.md','current\\n']]),{},${JSON.stringify(directory)});
 if(stale.length){console.error('Stale protocol reference');process.exitCode=1;}
} else if(args.join(' ')==='run check:deps') {
 const result=spawnSync(${JSON.stringify(join(repository, "node_modules/.bin/depcruise"))},${JSON.stringify([...sources.map((source) => `${source}/src`), "--config", config, "--output-type", "err"])},{cwd:${JSON.stringify(directory)},encoding:'utf8'});
 process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status??1;
}
`,
        { mode: 0o755 },
      );
      const commands = steps.flatMap((step) =>
        step.run?.startsWith("bun run ") ? [step.run] : [],
      );
      const run = () =>
        execute("/bin/bash", ["-e", "-c", commands.join("\n")], {
          cwd: directory,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
      await expect(run()).resolves.toMatchObject({ stderr: "" });
      if (defect === "stale reference")
        await writeFile(join(directory, "docs/protocol/README.md"), "stale\n");
      else await writeFile(join(directory, "packages/client/src/entry.ts"), 'import "node:fs";');
      await expect(
        execute("/bin/bash", ["-e", "-c", commands.join("\n")], {
          cwd: directory,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        }),
      ).rejects.toMatchObject({
        [defect === "stale reference" ? "stderr" : "stdout"]: expect.stringContaining(
          defect === "stale reference" ? "Stale protocol reference" : "browser-no-node",
        ),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
