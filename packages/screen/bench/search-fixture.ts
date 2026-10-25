/** Builds an owned background app, runs the search comparison and tears down its processes. */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";

if (process.platform !== "darwin") throw new Error("Requires macOS");
const config = z.object({ before: z.string().min(1), after: z.string().min(1) }).parse({
  before: process.env["ACE_CU_BASELINE_HELPER"],
  after: process.env["ACE_COMPUTER_HELPER"],
});
const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "ace-query-bench-"));
const app = `dev.ace.query-fixture-${randomUUID()}`;
const bundle = join(directory, "QueryFixture.app");
const executable = join(bundle, "Contents", "MacOS", "QueryFixture");
let fixture: SupervisedProcess | undefined;
let worker: SupervisedProcess | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${app}</string>
<key>CFBundleExecutable</key><string>QueryFixture</string><key>CFBundleName</key><string>ace query fixture</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
  );
  execFileSync("swiftc", [
    "-parse-as-library",
    join(root, "native/screen-helper/Tests/Fixture/QueryFixture.swift"),
    "-o",
    executable,
  ]);
  execFileSync("codesign", ["--force", "--sign", "-", bundle], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  fixture = spawnSupervised({
    command: executable,
    args: ["-ApplePersistenceIgnoreState", "YES"],
    env: { ...process.env },
    name: "owned-query-fixture",
  });
  await Promise.race([
    once(fixture.stdout, "line").then((line) => {
      z.tuple([z.literal("ready")]).parse(line);
    }),
    fixture.exited.then(() => {
      throw new Error("Fixture exited before readiness");
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Fixture readiness timed out")), 10_000);
    }),
  ]);
  clearTimeout(timer);
  timer = undefined;
  worker = spawnSupervised({
    command: process.execPath,
    args: [join(root, "packages/screen/bench/search.ts")],
    cwd: root,
    env: {
      ...process.env,
      ACE_CU_BASELINE_HELPER: config.before,
      ACE_COMPUTER_HELPER: config.after,
      ACE_CU_BENCH_APP: app,
    },
    name: "owned-query-comparison",
  });
  worker.stdout.on("line", (line) => process.stdout.write(`${line}\n`));
  worker.stderr.on("line", (line) => process.stderr.write(`${line}\n`));
  const exit = await worker.exited;
  if (exit.code !== 0) throw new Error(`Query benchmark failed (${exit.reason})`);
} finally {
  if (timer !== undefined) clearTimeout(timer);
  await worker?.stop({ graceMs: 500 });
  await fixture?.stop({ graceMs: 500 });
  await rm(directory, { recursive: true, force: true });
}
