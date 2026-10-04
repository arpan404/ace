import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");

test("browser dependency checks reject built-ins and Node-only exports while permitting portable exports and test edges", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-browser-deps-"));
  const sources = [
    "apps/web",
    ...["client", "client-worker", "client-react", "ui-core", "fake-daemon"].map(
      (name) => `packages/${name}`,
    ),
  ];
  try {
    for (const source of [...sources, "packages/settings", "node_modules/@ace"])
      await mkdir(join(directory, source, "src"), { recursive: true });
    await symlink(
      join(directory, "packages/settings"),
      join(directory, "node_modules/@ace/settings"),
    );
    await writeFile(
      join(directory, "packages/settings/package.json"),
      JSON.stringify({
        name: "@ace/settings",
        exports: { ".": "./src/index.ts", "./defaults": "./src/defaults.ts" },
      }),
    );
    await writeFile(
      join(directory, "packages/settings/src/index.ts"),
      'export { readFile } from "node:fs/promises";',
    );
    await writeFile(
      join(directory, "packages/settings/src/defaults.ts"),
      "export const defaults = {};",
    );
    const config = join(directory, "deps.cjs");
    await writeFile(
      config,
      `const config = require(${JSON.stringify(join(root, ".dependency-cruiser.cjs"))}); config.options.webpackConfig.fileName = ${JSON.stringify(join(root, "scripts/depcruise-resolve.cjs"))}; module.exports = config;`,
    );
    const check = () =>
      execute(
        join(root, "node_modules/.bin/depcruise"),
        [...sources.map((source) => `${source}/src`), "--config", config, "--output-type", "err"],
        { cwd: directory },
      );
    for (const source of sources) {
      const file = join(directory, source, "src/entry.ts");
      for (const dependency of ["node:fs", "fs", "@ace/settings"]) {
        await writeFile(file, `import ${JSON.stringify(dependency)};`);
        await expect(check()).rejects.toMatchObject({
          code: expect.any(Number),
          stdout: expect.stringContaining("browser-no-node"),
        });
      }
      await writeFile(file, 'import "@ace/settings/defaults";');
      await writeFile(join(directory, source, "src/entry.process.test.ts"), 'import "node:fs";');
      await expect(check()).resolves.toMatchObject({
        stdout: expect.stringContaining("no dependency violations found"),
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
