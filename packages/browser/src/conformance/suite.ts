import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { BrowserArtifact } from "@ace/protocol";
import type { BrowserService } from "../service.ts";
import type { ConformanceEngine, ConformancePage, ConformanceScenario } from "./engine.ts";
import { startFixtureSite, type FixtureSite } from "./fixture-site.ts";
import { scenarios as allScenarios } from "./scenarios.ts";

/** A scenario that neither passes nor fails in this long has hung; that is a failure too. */
const scenarioTimeout = 90_000;
/** An unsupported feature must refuse well before a hang would. */
const refusalDeadline = 20_000;

type Cleanups = (() => Promise<void> | void)[];

async function closeAll(cleanups: Cleanups): Promise<void> {
  for (const close of cleanups.splice(0).toReversed()) await close();
}

/** One running engine and fixture site; each scenario gets its own thread and workspace in it. */
interface EngineRun {
  service: BrowserService;
  site: FixtureSite;
  home: string;
  artifacts: Map<string, BrowserArtifact[]>;
}

async function startEngine(engine: ConformanceEngine, cleanups: Cleanups): Promise<EngineRun> {
  const home = await mkdtemp(join(tmpdir(), "ace-conformance-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const site = await startFixtureSite();
  cleanups.push(() => site.close());
  const artifacts = new Map<string, BrowserArtifact[]>();
  const service = await engine.start({
    options: {
      dataDir: join(home, "data"),
      workspaceRoot: (threadId) => join(home, "workspaces", threadId),
      onArtifact: (threadId, artifact) => {
        const list = artifacts.get(threadId) ?? [];
        list.push(artifact);
        artifacts.set(threadId, list);
      },
    },
    cleanup: (close) => void cleanups.push(close),
  });
  cleanups.push(() => service.close());
  return { service, site, home, artifacts };
}

/** Opens a fresh thread browser in a running engine; it closes after the scenario. */
async function openPage(run: EngineRun, threadId: string, cleanups: Cleanups) {
  const { service } = run;
  const workspace = join(run.home, "workspaces", threadId);
  await mkdir(workspace, { recursive: true });
  const artifacts: BrowserArtifact[] = [];
  run.artifacts.set(threadId, artifacts);
  await service.open({ threadId, workspaceId: "conformance-workspace", background: true });
  cleanups.push(() => service.closeThread(threadId));
  const execute = (command: unknown) => service.execute(threadId, command);
  const page: ConformancePage = {
    service,
    threadId,
    site: run.site,
    workspace,
    artifacts,
    execute,
    evaluate: (expression, tabId) =>
      execute({ action: "evaluate", expression, ...(tabId ? { tabId } : {}) }),
  };
  return page;
}

function refusesPromptly(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Hung instead of refusing within ${refusalDeadline} ms`)),
      refusalDeadline,
    );
  });
  return Promise.race([work, hung]).finally(() => clearTimeout(timer));
}

/**
 * The shared browser behaviour suite, run against one engine. Every scenario drives the
 * engine through `BrowserService.execute`, the surface agents' tools use, so a feature that
 * works in one engine only shows up as a failure in the others.
 *
 * Passing scenarios share one engine per file, each in a fresh thread browser of its own.
 * Known failures and expected refusals get an engine of their own, so whatever state they
 * leave behind cannot reach another scenario.
 */
export function defineBrowserConformance(
  engine: ConformanceEngine,
  scenarios: readonly ConformanceScenario[] = allScenarios,
): void {
  const title = engine.unavailable
    ? `browser conformance: ${engine.name} (skipped: ${engine.unavailable})`
    : `browser conformance: ${engine.name}`;
  describe.skipIf(engine.unavailable !== undefined)(title, () => {
    const engineCleanups: Cleanups = [];
    const scenarioCleanups: Cleanups = [];
    let shared: Promise<EngineRun> | undefined;
    afterEach(() => closeAll(scenarioCleanups), 60_000);
    afterAll(() => closeAll(engineCleanups), 60_000);
    const sharedPage = async (id: string) =>
      openPage(await (shared ??= startEngine(engine, engineCleanups)), id, scenarioCleanups);
    const isolatedPage = async (id: string) =>
      openPage(await startEngine(engine, scenarioCleanups), id, scenarioCleanups);
    for (const scenario of scenarios) {
      const threadId = `conformance-${scenario.id}`;
      const skip = engine.harnessSkips?.[scenario.id];
      const known = engine.knownFailures?.[scenario.id];
      const refusal = engine.unsupported?.[scenario.id];
      if (skip) {
        it.skip(`${scenario.title} (harness cannot run it: ${skip})`, () => {});
        continue;
      }
      if (refusal) {
        it(
          `${scenario.title}: refused as unsupported (${refusal})`,
          async () => {
            const page = await isolatedPage(threadId);
            await expect(refusesPromptly(scenario.run(page))).rejects.toMatchObject({
              code: refusal,
            });
          },
          scenarioTimeout,
        );
        continue;
      }
      if (known) {
        it.fails(
          `${scenario.title} (known failure: ${known})`,
          async () => scenario.run(await isolatedPage(threadId)),
          scenarioTimeout,
        );
        continue;
      }
      it(scenario.title, async () => scenario.run(await sharedPage(threadId)), scenarioTimeout);
    }
  });
}
