import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, relative, sep } from "node:path";
import type { Reporter, TestModule } from "vitest/node";

export interface TimingRecord {
  file: string;
  project: string;
  state: string;
  /** Tests and hooks: what the budgets measure. Imports are left out because a cold transform
   * cache or a busy machine inflates them for reasons unrelated to the file. */
  ownMs: number;
  collectMs: number;
  testsMs: number;
  setupMs: number;
  environmentMs: number;
}

export interface TimingSummary {
  finishedAt: string;
  workers: number;
  cpus: number;
  files: TimingRecord[];
}

const round = (ms: number) => Math.round(ms);

/** Writes per-file durations as JSON when ACE_TEST_TIMINGS_FILE names a path; otherwise idle. */
export class TimingReporter implements Reporter {
  readonly #path: string | undefined;
  readonly #root: string;
  readonly #workers: number;
  /** `root` is the repository root, so file paths match across projects with their own roots. */
  constructor(path: string | undefined, root: string, workers: number) {
    this.#path = path;
    this.#root = root;
    this.#workers = workers;
  }

  onTestRunEnd(modules: readonly TestModule[]): void {
    if (!this.#path) return;
    const files = modules.map((module): TimingRecord => {
      const diagnostic = module.diagnostic();
      return {
        file: relative(this.#root, module.moduleId).split(sep).join("/"),
        project: module.project.name,
        state: module.state(),
        ownMs: round(diagnostic.duration),
        collectMs: round(diagnostic.collectDuration),
        testsMs: round(diagnostic.duration),
        setupMs: round(diagnostic.setupDuration),
        environmentMs: round(diagnostic.environmentSetupDuration),
      };
    });
    files.sort((a, b) => b.ownMs - a.ownMs);
    const summary: TimingSummary = {
      finishedAt: new Date().toISOString(),
      workers: this.#workers,
      cpus: availableParallelism(),
      files,
    };
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, `${JSON.stringify(summary, null, 1)}\n`);
  }
}
