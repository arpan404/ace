import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { claude } from "./providers/claude.ts";
import { codex } from "./providers/codex.ts";
import { cursor } from "./providers/cursor.ts";
import { opencode } from "./providers/opencode.ts";
import type { Driver, RunContext } from "./providers/types.ts";
import { Recording, type RecordingHeader } from "./recording.ts";
import { createRedactor } from "./redact.ts";
import { SCENARIOS, findScenario, type Scenario } from "./scenarios.ts";
import { createWorkspace } from "./workspace.ts";

const DRIVERS: readonly Driver[] = [claude, codex, opencode, cursor];
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const RAW_DIR = join(REPO_ROOT, ".recordings");
const FIXTURE_DIR = join(REPO_ROOT, "fixtures");

/** Write the redacted copy of a raw recording into fixtures/, mirroring its path. */
function writeFixture(rawPath: string): string {
  const lines = readFileSync(rawPath, "utf8").split("\n").filter(Boolean);
  const header = JSON.parse(lines[0] ?? "{}") as RecordingHeader;
  const redact = createRedactor({ workspace: header.workspace });
  const fixturePath = join(FIXTURE_DIR, relative(RAW_DIR, rawPath));
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, `${lines.map(redact).join("\n")}\n`);
  return fixturePath;
}

function settleWatcher(rec: Recording, scenario: Scenario, signal: AbortSignal) {
  let open = 0;
  const interactions = { open: () => void open++, close: () => void open-- };
  const settled = () =>
    new Promise<void>((done) => {
      const timer = setInterval(() => {
        if (signal.aborted) return finish("aborted");
        if (rec.elapsedMs() >= scenario.maxMs) return finish("max-time");
        if (rec.marks("turn-end") > 0 && open === 0 && rec.quietForMs() >= scenario.quietMs) {
          finish("settled");
        }
      }, 250);
      function finish(reason: string) {
        clearInterval(timer);
        rec.note("stop", { reason });
        done();
      }
    });
  return { settled, interactions };
}

async function runOne(
  driver: Driver,
  version: string,
  scenario: Scenario,
  model: string | undefined,
): Promise<string> {
  const workspace = createWorkspace(`${driver.id}-${scenario.id}`);
  const rawPath = join(RAW_DIR, driver.id, version, `${scenario.id}.jsonl`);
  const rec = new Recording(rawPath, {
    format: "ace-recording/v1",
    provider: driver.id,
    cliVersion: version,
    scenario: scenario.id,
    startedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    workspace,
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
      if (driver.unsupported?.includes(scenario.id)) continue;
      const started = Date.now();
      process.stdout.write(`${driver.id}@${version} ${scenario.id} … `);
      const path = await runOne(driver, version, scenario, values.model);
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      process.stdout.write(`${seconds}s → ${path.replace(`${REPO_ROOT}/`, "")}\n`);
    }
  }
}

await main();
