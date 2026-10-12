import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanTypecheck, prepareTypecheck } from "./typecheck-projects.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = fileURLToPath(new URL("./bin/tsc", import.meta.resolve("typescript/package.json")));
process.env.GOMAXPROCS = "2";
mkdirSync(join(root, ".cache/typecheck"), { recursive: true });
const fixture = mkdtempSync(join(root, ".cache/typecheck/regression-"));

function write(file: string, text: string): void {
  const path = join(fixture, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function config(file: string, value: unknown): void {
  write(file, JSON.stringify(value));
}

function build(): { status: number | null; output: string } {
  const projects = prepareTypecheck(fixture);
  let status: number | null = 0;
  let output = "";
  for (const project of [projects.declarations, projects.checks]) {
    const result = spawnSync(
      process.execPath,
      [tsc, "-b", project, "--builders", "2", "--checkers", "1"],
      { cwd: fixture, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) status = result.status;
    output += result.stdout + result.stderr;
  }
  return { status, output };
}

function passes(): void {
  const result = build();
  assert.equal(result.status, 0, result.output);
  const full = fullSourceCheck();
  assert.equal(full.status, 0, full.stdout + full.stderr);
}

function rejects(diagnostic: RegExp): void {
  const result = build();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, diagnostic);
  const full = fullSourceCheck();
  assert.notEqual(full.status, 0, full.stdout + full.stderr);
  assert.match(full.stdout + full.stderr, diagnostic);
}

function fullSourceCheck(): SpawnSyncReturns<string> {
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/typecheck-full.ts"), join(fixture, "packages/consumer/tsconfig.json")],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  return result;
}

try {
  for (const directory of ["apps", "tools"]) mkdirSync(join(fixture, directory));
  config("tsconfig.base.json", {
    compilerOptions: {
      target: "es2024",
      module: "nodenext",
      strict: true,
      types: [],
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      noEmit: true,
    },
  });
  config("tsconfig.tests.json", { extends: "./tsconfig.base.json", files: ["test.ts"] });
  write("test.ts", "export {};\n");
  for (const name of ["producer", "wrapper", "consumer"]) {
    const dependencies =
      name === "producer"
        ? {}
        : { [`@ace/probe-${name === "wrapper" ? "producer" : "wrapper"}`]: "workspace:*" };
    config(`packages/${name}/package.json`, {
      name: `@ace/probe-${name}`,
      type: "module",
      exports: { ".": "./src/index.ts", "./sdk": "./src/sdk.ts" },
      scripts: { typecheck: "probe" },
      dependencies,
    });
    config(`packages/${name}/tsconfig.json`, {
      extends: "../../tsconfig.base.json",
      include: ["src"],
    });
    write(`packages/${name}/src/sdk.ts`, "export {};\n");
    mkdirSync(join(fixture, "node_modules/@ace"), { recursive: true });
    symlinkSync(
      join(fixture, "packages", name),
      join(fixture, "node_modules/@ace", `probe-${name}`),
    );
  }
  const producer = "packages/producer/src/index.ts";
  const consumer = "packages/consumer/src/index.ts";
  const augmentation = "packages/consumer/src/augmentation.ts";
  write(
    "packages/producer/src/sdk.ts",
    "export interface Options {}\nexport function discover(options: Options = {}): Options { return options; }\n",
  );
  write(producer, "export const value = { nested: { slot: { count: 1 } } };\n");
  write("packages/wrapper/src/index.ts", 'export { value } from "@ace/probe-producer";\n');
  write(
    consumer,
    'import { value } from "@ace/probe-wrapper";\nvalue.nested.slot = { count: 1 };\n',
  );
  write(augmentation, 'import "@ace/probe-producer/sdk";\n');
  passes();

  const timestamp = statSync(join(fixture, augmentation));
  write(
    augmentation,
    'import "@ace/probe-producer/sdk";\ndeclare module "@ace/probe-producer/sdk" { interface Options { requiredProbe: string; } }\n',
  );
  utimesSync(join(fixture, augmentation), timestamp.atime, timestamp.mtime);
  rejects(/producer\/src\/sdk\.ts.*error TS2741/);
  rejects(/producer\/src\/sdk\.ts.*error TS2741/);
  cleanTypecheck(fixture);
  rejects(/producer\/src\/sdk\.ts.*error TS2741/);
  write(augmentation, 'import "@ace/probe-producer/sdk";\n');
  passes();
  console.log("Workspace augmentation: warm, cached failure, cold, and recovery passed.");

  // Exercise an imported const-generic signature and a transitive workspace re-export.
  config("node_modules/probe-helper/package.json", {
    name: "probe-helper",
    type: "module",
    exports: "./index.d.ts",
  });
  write(
    "node_modules/probe-helper/index.d.ts",
    "export declare function retain<const T>(value: T): T;\n",
  );
  const producerTimestamp = statSync(join(fixture, producer));
  write(
    producer,
    'import { retain } from "probe-helper";\nconst leaf = { count: 1 } as const;\nexport const value = retain({ nested: { slot: leaf } });\n',
  );
  utimesSync(join(fixture, producer), producerTimestamp.atime, producerTimestamp.mtime);
  rejects(/consumer\/src\/index\.ts.*error TS2540/);
  rejects(/consumer\/src\/index\.ts.*error TS2540/);
  cleanTypecheck(fixture);
  rejects(/consumer\/src\/index\.ts.*error TS2540/);
  write(
    consumer,
    'import { value } from "@ace/probe-wrapper";\nconsole.log(value.nested.slot.count);\n',
  );
  passes();
  console.log("Const-generic readonly: warm, cached failure, cold, and recovery passed.");

  // A consumer-only external global must recheck the producer's erased initializer.
  config("node_modules/probe-env/package.json", {
    name: "probe-env",
    type: "module",
    exports: "./index.d.ts",
  });
  const environment = "node_modules/probe-env/index.d.ts";
  write(environment, "export {};\n");
  write(
    producer,
    "export function discover(options: ErrorOptions = {}): ErrorOptions { return options; }\n",
  );
  write(
    consumer,
    'import "probe-env";\nimport { discover } from "@ace/probe-producer";\nexport { discover };\n',
  );
  write("packages/wrapper/src/index.ts", 'export { discover } from "@ace/probe-producer";\n');
  passes();
  const environmentTimestamp = statSync(join(fixture, environment));
  write(
    environment,
    "export {};\ndeclare global { interface ErrorOptions { requiredProbe: string } }\n",
  );
  utimesSync(join(fixture, environment), environmentTimestamp.atime, environmentTimestamp.mtime);
  rejects(/producer\/src\/index\.ts.*error TS2741/);
  rejects(/producer\/src\/index\.ts.*error TS2741/);
  cleanTypecheck(fixture);
  rejects(/producer\/src\/index\.ts.*error TS2741/);
  write(environment, "export {};\n");
  passes();
  console.log(
    "External global augmentation: warm preserved-mtime, cached failure, cold, and recovery passed.",
  );

  // A bare declaration script merges globals without `declare global` metadata.
  write(environment, "interface ErrorOptions {}\n");
  passes();
  const scriptTimestamp = statSync(join(fixture, environment));
  write(environment, "interface ErrorOptions { requiredProbe: string; }\n");
  utimesSync(join(fixture, environment), scriptTimestamp.atime, scriptTimestamp.mtime);
  rejects(/producer\/src\/index\.ts.*error TS2741/);
  rejects(/producer\/src\/index\.ts.*error TS2741/);
  cleanTypecheck(fixture);
  rejects(/producer\/src\/index\.ts.*error TS2741/);
  write(environment, "interface ErrorOptions {}\n");
  passes();
  console.log(
    "External global script: warm preserved-mtime, cached failure, cold, and recovery passed.",
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
