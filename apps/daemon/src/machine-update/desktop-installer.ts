import type { AppUpdateReport, MachineUpdateAsk } from "@ace/protocol";
import type { AppUpdateBoard } from "../app-update-board.ts";
import type { InstallEnd, Installer } from "./installer.ts";
import type { InstallerFacts, InstallerPhase } from "./rules.ts";

/**
 * How long the app may take to pick up an install: it sends its report every 20 seconds and
 * hears the instruction in the reply, so this is several missed reports.
 */
export const appPickupMs = 90_000;

const phases: Record<string, InstallerPhase> = {
  available: "available",
  downloading: "downloading",
  downloaded: "ready",
  installing: "installing",
};

/** What the app's own report says, as installer facts. */
export function appFacts(
  report: AppUpdateReport | null,
  reportedAt: number | null,
): InstallerFacts {
  const base = {
    releaseUrl: report?.releaseUrl ?? null,
    percent: report?.percent ?? null,
    checkedAt: reportedAt,
    downloadsFirst: true,
  };
  if (!report)
    return {
      ...base,
      available: null,
      blocked: "app-closed",
      phase: "none",
      error: "The ace app isn't open there. Open it to update.",
    };
  const phase: InstallerPhase =
    (report.state !== undefined ? phases[report.state] : undefined) ??
    (report.available ? (report.downloaded ? "ready" : "available") : "none");
  if (report.state === undefined)
    // An app from before remote updates never hears an instruction.
    return {
      ...base,
      available: report.available,
      blocked: "unknown",
      phase,
      error: "This ace app is older than remote updates. Update it on that computer once.",
    };
  return {
    ...base,
    available: report.available,
    blocked: report.inPlace === false && report.available ? "release-page" : null,
    phase,
    error: report.error ?? null,
  };
}

/**
 * The desktop app installs: it downloads, drains or stops agents through its own quit gate,
 * and restarts with its new daemon (ADR 0091). The daemon only tells it what to do, in the
 * reply to the report the app sends every 20 seconds.
 */
export function desktopInstaller(
  board: AppUpdateBoard,
  clock: { delay(callback: () => void, ms: number): () => void },
): Installer {
  let attempt = 0;
  let watching: (() => void) | undefined;
  const facts = () => {
    const current = board.current();
    return appFacts(current.report, current.reportedAt);
  };
  return {
    install: "desktop",
    facts,
    onChange: (listener) => board.onChange(() => listener()),
    // The app asks its feed every minute or two by itself.
    check: async () => {},
    download(ask: MachineUpdateAsk) {
      board.instruct({
        id: `${ask.id}:download`,
        action: "download",
        mode: ask.mode,
        version: ask.version,
      });
    },
    begin(ask, mode, ended) {
      watching?.();
      attempt += 1;
      board.instruct({
        id: `${ask.id}:install:${attempt}`,
        action: "install",
        mode,
        version: ask.version,
      });
      let picked = false;
      const finish = (end: InstallEnd) => {
        stop();
        board.instruct(null);
        ended(end);
      };
      const cancelPickup = clock.delay(() => {
        if (!picked)
          finish({ ok: false, error: "The ace app didn't start the update.", busy: false });
      }, appPickupMs);
      const unlisten = board.onChange((update) => {
        const report = update.report;
        // The app withdraws its report as it quits to install: the restart follows.
        if (!report) return;
        const now = appFacts(report, update.reportedAt);
        if (now.phase === "installing") {
          picked = true;
          return;
        }
        if (!picked) return;
        // Back from installing without a restart: its drain met work, or it couldn't install.
        finish({
          ok: false,
          error: now.error ?? "The ace app didn't install the update.",
          busy: mode === "idle" && now.phase === "ready",
        });
      });
      const stop = () => {
        cancelPickup();
        unlisten();
        watching = undefined;
      };
      watching = stop;
    },
    close() {
      watching?.();
    },
  };
}
