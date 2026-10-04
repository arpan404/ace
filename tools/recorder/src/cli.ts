import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { installShutdownHandlers } from "@ace/provider-kit/process";
import { claude } from "./providers/claude.ts";
import { codex } from "./providers/codex.ts";
import { cursor } from "./providers/cursor.ts";
import { opencode } from "./providers/opencode.ts";
import type { Driver, RunContext } from "./providers/types.ts";
import { Recording } from "./recording.ts";
import { createRecordingRedactor } from "./fragment-redaction.ts";
import { SCENARIOS, findScenario, type Scenario } from "./scenarios.ts";
import { settleWatcher } from "./settle.ts";
import { createWorkspace } from "./workspace.ts";

const DRIVERS: readonly Driver[] = [claude, codex, opencode, cursor];
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const RAW_DIR = join(REPO_ROOT, ".recordings");
const FIXTURE_DIR = join(REPO_ROOT, "fixtures");

/** Write the redacted copy of a raw recording into fixtures/, mirroring its path. */
function writeFixture(rawPath: string): string {
  const lines = readFileSync(rawPath, "utf8").split("\n").filter(Boolean);
  const header = z.object({ workspace: z.string() }).parse(JSON.parse(lines[0] ?? "{}"));
  const redact = createRecordingRedactor({ workspace: header.workspace });
  const fixturePath = join(FIXTURE_DIR, relative(RAW_DIR, rawPath));
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(
    fixturePath,
    `${[...lines.flatMap((line) => redact.push(line)), ...redact.finish()].join("\n")}\n`,
  );
  return fixturePath;
}

async function runOne(
  driver: Driver,
  version: string,
  scenario: Scenario,
  model: string | undefined,
): Promise<string> {
  const modelDirectory =
    driver.id === "opencode"
      ? (model ?? "opencode-go/muse-spark-1.3-contributor").split("/").at(-1)
      : undefined;
  if (modelDirectory && !/^[a-zA-Z0-9._-]+$/.test(modelDirectory))
    throw new Error("Invalid model directory");
  const rawPath = join(
    RAW_DIR,
    driver.id,
    version,
    ...(modelDirectory ? [modelDirectory] : []),
    `${scenario.id}.jsonl`,
  );
  const fixturePath = join(FIXTURE_DIR, relative(RAW_DIR, rawPath));
  if (existsSync(rawPath) || existsSync(fixturePath))
    throw new Error(
      `Capture already exists for ${driver.id}/${version}/${scenario.id}; a new attempt needs approval and a separate path`,
    );
  const workspace = createWorkspace(`${driver.id}-${scenario.id}`);
  const rec = new Recording(rawPath, {
    format: "ace-recording/v1",
    provider: driver.id,
    cliVersion: version,
    scenario: scenario.id,
    startedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    workspace,
    ...(model ? { model } : {}),
  });
  const abort = new AbortController();
  const { settled, interactions } = settleWatcher(rec, scenario, abort.signal);
  const ctx: RunContext = {
    scenario,
    workspace,
    rec,
    signal: abort.signal,
    settled,
    interactions,
    ...(model ? { model } : {}),
  };
  try {
    await driver.run(ctx);
  } catch (error) {
    rec.note("driver-error", error instanceof Error ? error.stack : String(error));
  } finally {
    abort.abort();
    await rec.close();
  }

  rmSync(workspace, { recursive: true, force: true });
  return writeFixture(rawPath);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string", default: DRIVERS.map((d) => d.id).join(",") },
      scenario: { type: "string", default: SCENARIOS.map((s) => s.id).join(",") },
      model: { type: "string" },
      "redact-only": { type: "boolean", default: false },
    },
  });
  if (values["redact-only"]) {
    const raw = readdirSync(RAW_DIR, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".jsonl"))
      .map((path) => join(RAW_DIR, path));
    for (const path of raw) process.stdout.write(`${relative(REPO_ROOT, writeFixture(path))}\n`);
    return;
  }
  const providers = (values.provider ?? "").split(",").filter(Boolean);
  const scenarios = (values.scenario ?? "").split(",").filter(Boolean).map(findScenario);

  for (const id of providers) {
    const driver = DRIVERS.find((d) => d.id === id);
    if (!driver) throw new Error(`Unknown provider: ${id}`);
    const version = await driver.version();
    for (const scenario of scenarios) {
      if (driver.unsupported?.includes(scenario.id)) {
        process.stdout.write(`${driver.id}@${version} ${scenario.id}: skipped (unsupported)\n`);
        continue;
      }
      const started = Date.now();
      process.stdout.write(`${driver.id}@${version} ${scenario.id} … `);
      const path = await runOne(driver, version, scenario, values.model);
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      process.stdout.write(`${seconds}s → ${path.replace(`${REPO_ROOT}/`, "")}\n`);
    }
  }
}

const removeShutdownHandlers = installShutdownHandlers({ graceMs: 5_000 });
try {
  await main();
} finally {
  removeShutdownHandlers();
}
