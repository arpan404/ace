import type { BrowserArtifact } from "@ace/protocol";
import type { BrowserService } from "../service.ts";
import type { BrowserServiceOptions } from "../service-options.ts";
import type { FixtureSite } from "./fixture-site.ts";

/** What every engine's service is built with, so scenarios see the same daemon settings. */
export type ConformanceServiceOptions = Pick<
  BrowserServiceOptions,
  "dataDir" | "workspaceRoot" | "onArtifact"
>;

export interface ConformanceEngineContext {
  options: ConformanceServiceOptions;
  /** Runs after the scenario, newest first, whether it passed or not. */
  cleanup(close: () => Promise<void> | void): void;
}

/** One way of reaching a page: ace's Chrome, the desktop's native view or the person's Chrome. */
export interface ConformanceEngine {
  name: string;
  /** Why this engine cannot run on this machine; the whole engine is then reported skipped. */
  unavailable: string | undefined;
  /**
   * A `BrowserService` whose thread browsers open in this engine. The suite opens the thread.
   * Spread `context.options` into the service so downloads and uploads land where scenarios look.
   */
  start(context: ConformanceEngineContext): Promise<BrowserService>;
  /**
   * Features this engine documents as unsupported, by scenario id, with the public error code a
   * scenario must fail with (promptly, never by hanging).
   */
  unsupported?: Readonly<Record<string, string>>;
  /** Known engine gaps by scenario id: they run as expected failures until fixed. */
  knownFailures?: Readonly<Record<string, string>>;
  /** Scenarios this engine's test harness cannot exercise, with why; never engine gaps. */
  harnessSkips?: Readonly<Record<string, string>>;
}

/** What a scenario gets: the thread's browser in one engine, and the site to browse. */
export interface ConformancePage {
  service: BrowserService;
  threadId: string;
  site: FixtureSite;
  /** The workspace root uploads resolve relative paths against. */
  workspace: string;
  artifacts: BrowserArtifact[];
  execute(command: unknown): Promise<unknown>;
  evaluate(expression: string, tabId?: string): Promise<unknown>;
}

export interface ConformanceScenario {
  id: string;
  /** The behaviour it guards, as a sentence. */
  title: string;
  run(page: ConformancePage): Promise<void>;
}
