import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { parseTestEnvironment } from "@ace/provider-kit/test-isolation";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { bunBinary, realNode } from "./runtimes.ts";
import { splitByRuntime } from "./test-tiers.ts";

const repository = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const project = (name: string) => ["--project", name];
function observation(line: string) {
  const { project, home, data, xdg, tmp } = parseTestEnvironment(JSON.parse(line));
  if (!project || !home || !data || !xdg || !tmp)
    throw new Error("Incomplete isolation observation");
  return { project, home, data, xdg, tmp };
}

async function rehearsal(cleanup: (close: () => Promise<void>) => void) {
  const root = await mkdtemp(join(tmpdir(), "ace-isolation-rehearsal-"));
  cleanup(() => rm(root, { recursive: true, force: true }));
  const protectedHome = join(root, "owner");
  await mkdir(protectedHome);
  await symlink(join(repository, "node_modules"), join(root, "node_modules"), "junction");
  const fixture = join(root, "isolation.fixture.test.ts");
  const setup = join(root, "after-isolation.mjs");
  await writeFile(
    setup,
    `
    import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
    if (process.env.ACE_ACCOUNTS_DB) throw new Error('Inherited account selector survived worker setup');
    writeFileSync(join(process.env.HOME, 'setup-ready'), 'private');
  `,
  );
  await writeFile(
    fixture,
    `
    import {readFileSync, appendFileSync} from 'node:fs'; import {join} from 'node:path';
    import {expect, test, inject} from 'vitest';
    // Top-level evaluation, before the test body, must already be isolated.
    const home = process.env.HOME;
    if (!home || home === ${JSON.stringify(protectedHome)}) throw new Error('Protected HOME reached module evaluation');
    const ready = readFileSync(join(home, 'setup-ready'), 'utf8');
    test('each project isolates user and XDG homes before module evaluation', () => {
      expect(ready).toBe('private');
      expect(process.env.ACE_HISTORY_INSTANCES).toBe('[]');
      for (const key of ['ACE_HOME','USERPROFILE','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','TMPDIR']) expect(process.env[key].startsWith(home)).toBe(true);
      appendFileSync(process.env.REHEARSAL_RESULT, JSON.stringify({project:inject('rehearsalProject'), home, data:process.env.ACE_HOME, xdg:process.env.XDG_DATA_HOME, tmp:process.env.TMPDIR})+'\\n');
    });
  `,
  );
  const config = join(root, "vitest.config.mjs");
  await writeFile(
    config,
    `
    import config from ${JSON.stringify(new URL("../vitest.config.ts", import.meta.url).href)};
    export default {...config, test:{...config.test, projects:config.test.projects.map(project => ({...project, test:{...project.test, include:[${JSON.stringify(fixture)}], exclude:[], setupFiles:[...project.test.setupFiles,${JSON.stringify(setup)}], provide:{...project.test.provide,rehearsalProject:project.test.name}}}))}};
  `,
  );
  const env = {
    ...process.env,
    HOME: protectedHome,
    USERPROFILE: protectedHome,
    ACE_TEST_REAL_HOME: protectedHome,
    ACE_ACCOUNTS_DB: join(protectedHome, "accounts.sqlite"),
    CODEX_HOME: join(protectedHome, ".codex"),
    ZDOTDIR: protectedHome,
  };
  const vitest = (runtime: string, args: string[], result: string) => {
    const execution = execute(
      runtime,
      [join(repository, "node_modules/vitest/vitest.mjs"), "run", "--config", config, ...args],
      {
        cwd: repository,
        env: { ...env, REHEARSAL_RESULT: result },
        maxBuffer: 1024 * 1024,
        timeout: PROCESS_TEST_TIMEOUT,
      },
    );
    cleanup(async () => {
      if (execution.child.exitCode === null && execution.child.signalCode === null)
        execution.child.kill("SIGTERM");
      await execution.catch(() => {});
    });
    return execution;
  };
  // As `bun run test` does: Bun runs every project its config keeps, then Node runs the Node
  // projects (scripts/test-run.ts).
  const run = async (result: string) => {
    const passes = splitByRuntime([]);
    if (passes.bun) await vitest(bunBinary(), passes.bun.flatMap(project), result);
    const node = realNode();
    if (!node) throw new Error("The Node pass needs Node on PATH (a `node` that is not Bun)");
    if (passes.node) await vitest(node, passes.node.flatMap(project), result);
  };
  const single = (result: string) => vitest(process.execPath, [], result);
  return { root, protectedHome, config, fixture, setup, run, single };
}

test("all projects, on Bun and on Node, and concurrent runs own distinct homes and remove them after worker cleanup", async ({
  onTestFinished,
}) => {
  const fixture = await rehearsal(onTestFinished);
  const results = [join(fixture.root, "first.jsonl"), join(fixture.root, "second.jsonl")];
  const runs = await Promise.allSettled(results.map((result) => fixture.run(result)));
  for (const run of runs) if (run.status === "rejected") throw run.reason;
  const observations = [];
  for (const result of results) {
    const records = (await readFile(result, "utf8")).trim().split("\n").map(observation);
    expect(records.map((record) => record.project).toSorted()).toEqual([
      "browser-process",
      "client-react",
      "history-scale",
      "node-process",
      "process",
      "slow-process",
      "unit",
      "web",
    ]);
    observations.push(...records);
  }
  for (const field of ["home", "data", "xdg", "tmp"] as const)
    expect(new Set(observations.map((record) => record[field])).size).toBe(observations.length);
  for (const record of observations)
    await expect(stat(record.home)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(fixture.protectedHome, "accounts.sqlite"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("failed worker setup still removes the global root it acquired", async ({
  onTestFinished,
}) => {
  const fixture = await rehearsal(onTestFinished);
  const result = join(fixture.root, "failed.json");
  await writeFile(
    fixture.setup,
    `
    import {writeFileSync} from 'node:fs';
    writeFileSync(process.env.REHEARSAL_RESULT, JSON.stringify({home:process.env.HOME}));
    throw new Error('Deliberate isolated setup failure');
  `,
  );
  await writeFile(
    fixture.config,
    `
    import config from ${JSON.stringify(new URL("../vitest.config.ts", import.meta.url).href)};
    const project = config.test.projects.find(project => project.test.name === 'unit');
    export default {...config, test:{...config.test, projects:[{...project, test:{...project.test, include:[${JSON.stringify(fixture.fixture)}], exclude:[], setupFiles:[...project.test.setupFiles,${JSON.stringify(fixture.setup)}]}}]}};
  `,
  );
  await expect(fixture.single(result)).rejects.toThrow(/Deliberate isolated setup failure/);
  const observed = parseTestEnvironment(JSON.parse(await readFile(result, "utf8")));
  if (!observed.home) throw new Error("Missing acquired home from failed setup");
  await expect(stat(dirname(observed.home))).rejects.toMatchObject({ code: "ENOENT" });
});
