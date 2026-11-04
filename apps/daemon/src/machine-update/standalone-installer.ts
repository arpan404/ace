import { isNewer } from "@ace/service/version";
import type { InstallEnd, Installer } from "./installer.ts";
import { releasePage } from "./installer.ts";
import type { UpdaterOutcome } from "./record.ts";
import type { InstallerFacts } from "./rules.ts";

/** The standalone updater (`ace update`, ADR 0041), as this daemon reaches it. */
export interface UpdaterPorts {
  /** `ace update check`: the newest signed release for this target and channel. */
  check(): Promise<{ version: string }>;
  /**
   * Starts `ace update apply` outside this daemon's process tree. It stops the service, so on
   * success this daemon is replaced; `exited` settles only if it ends while this daemon lives.
   */
  launch(mode: "idle" | "now"): { exited: Promise<unknown> };
  /** Reads and removes the outcome the updater wrote. */
  takeOutcome(): Promise<UpdaterOutcome | undefined>;
}

/**
 * At most as often as the daily automatic update asks the feed (ADR 0041): once shortly after
 * start, then daily, plus a person's check no more than once a minute.
 */
export const standaloneChecks = { firstMs: 60_000, everyMs: 86_400_000, minGapMs: 60_000 };

/**
 * A standalone daemon updates through its own signed updater: the updater verifies the release,
 * snapshots the databases, swaps releases and restarts the service, rolling back if the new
 * version doesn't come up healthy.
 */
export function standaloneInstaller(options: {
  version: string;
  ports: UpdaterPorts;
  clock: { now(): number; delay(callback: () => void, ms: number): () => void };
  log(error: unknown): void;
}): Installer {
  const { ports, clock } = options;
  const listeners = new Set<() => void>();
  let facts: InstallerFacts = {
    available: null,
    releaseUrl: null,
    blocked: null,
    phase: "none",
    percent: null,
    error: null,
    checkedAt: null,
    downloadsFirst: false,
  };
  const tell = (next: InstallerFacts) => {
    facts = next;
    for (const listener of listeners) listener();
  };
  let checking: Promise<void> | undefined;
  let cancelTimer: (() => void) | undefined;
  let closed = false;
  const check = () =>
    (checking ??= (async () => {
      try {
        const release = await ports.check();
        const newer = isNewer(release.version, options.version);
        tell({
          ...facts,
          available: newer ? release.version : null,
          releaseUrl: newer ? releasePage(release.version) : null,
          error: null,
          checkedAt: clock.now(),
        });
      } catch (error) {
        options.log(error);
        tell({
          ...facts,
          error: "Couldn't reach the release feed. ace will try again later.",
          checkedAt: clock.now(),
        });
      } finally {
        checking = undefined;
      }
    })());
  const schedule = (ms: number) => {
    if (closed) return;
    cancelTimer = clock.delay(() => {
      void check().finally(() => schedule(standaloneChecks.everyMs));
    }, ms);
  };
  schedule(standaloneChecks.firstMs);
  return {
    install: "standalone",
    facts: () => facts,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async check() {
      if (facts.checkedAt !== null && clock.now() - facts.checkedAt < standaloneChecks.minGapMs)
        return;
      await check();
    },
    download() {},
    begin(_ask, mode, ended) {
      tell({ ...facts, phase: "installing", error: null });
      const finish = async (crashed?: unknown) => {
        const outcome = await ports.takeOutcome().catch(() => undefined);
        const end: InstallEnd = {
          ok: false,
          error:
            outcome?.error ??
            (crashed ? "The updater didn't start." : "The update stopped before it finished."),
          busy: outcome?.busy === true,
        };
        tell({ ...facts, phase: facts.available ? "available" : "none" });
        ended(end);
      };
      try {
        ports.launch(mode).exited.then(
          () => finish(),
          (error: unknown) => {
            options.log(error);
            return finish(error);
          },
        );
      } catch (error) {
        options.log(error);
        void finish(error);
      }
    },
    close() {
      closed = true;
      cancelTimer?.();
    },
  };
}
