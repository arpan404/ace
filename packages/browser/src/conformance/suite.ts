import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserArtifact } from "@ace/protocol";
import type { ConformanceEngine, ConformancePage, ConformanceScenario } from "./engine.ts";
import { startFixtureSite } from "./fixture-site.ts";
import { scenarios as allScenarios } from "./scenarios.ts";

/** A scenario that neither passes nor fails in this long has hung; that is a failure too. */
const scenarioTimeout = 90_000;
/** An unsupported feature must refuse well before a hang would. */
const refusalDeadline = 20_000;

async function openPage(engine: ConformanceEngine, cleanups: (() => Promise<void> | void)[]) {
  const home = await mkdtemp(join(tmpdir(), "ace-conformance-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const site = await startFixtureSite();
  cleanups.push(() => site.close());
  const artifacts: BrowserArtifact[] = [];
  const service = await engine.start({
    options: {
      dataDir: join(home, "data"),
      workspaceRoot: () => workspace,
      onArtifact: (_thread, artifact) => void artifacts.push(artifact),
    },
    cleanup: (close) => void cleanups.push(close),
  });
  cleanups.push(() => service.close());
  const threadId = "conformance-thread";
  await service.open({ threadId, workspaceId: "conformance-workspace", background: true });
  const execute = (command: unknown) => service.execute(threadId, command);
  const page: ConformancePage = {
    service,
    threadId,
    site,
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
 */
export function defineBrowserConformance(
  engine: ConformanceEngine,
  scenarios: readonly ConformanceScenario[] = allScenarios,
): void {
  const title = engine.unavailable
    ? `browser conformance: ${engine.name} (skipped: ${engine.unavailable})`
    : `browser conformance: ${engine.name}`;
  describe.skipIf(engine.unavailable !== undefined)(title, () => {
    const cleanups: (() => Promise<void> | void)[] = [];
    afterEach(async () => {
      for (const close of cleanups.splice(0).toReversed()) await close();
    }, 60_000);
    for (const scenario of scenarios) {
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
            const page = await openPage(engine, cleanups);
            await expect(refusesPromptly(scenario.run(page))).rejects.toMatchObject({
              code: refusal,
            });
          },
          scenarioTimeout,
        );
        continue;
      }
      const test = known ? it.fails : it;
      test(
        known ? `${scenario.title} (known failure: ${known})` : scenario.title,
        async () => scenario.run(await openPage(engine, cleanups)),
        scenarioTimeout,
      );
    }
  });
}
