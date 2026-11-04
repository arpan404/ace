import type { MachineInstall, MachineUpdateAsk } from "@ace/protocol";
import type { InstallerFacts } from "./rules.ts";

/** How an install this daemon started ended without restarting it. */
export interface InstallEnd {
  ok: boolean;
  error: string | null;
  /** Running agents outlasted the installer's drain; an update when idle tries again later. */
  busy: boolean;
}

/**
 * The thing that installs releases on this machine: the desktop app, the standalone updater,
 * or nothing (a source checkout). The coordinator decides; an installer only reports and acts.
 */
export interface Installer {
  readonly install: MachineInstall;
  facts(): InstallerFacts;
  /** Calls `listener` whenever the facts may have changed; returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  /** Asks the release feed now, where this installer asks it itself. */
  check(): Promise<void>;
  /** Starts downloading the release `ask` names, for installers that download first. */
  download(ask: MachineUpdateAsk): void;
  /**
   * Installs the release `ask` names. Success restarts this daemon, so only a failure, or a
   * drain that work outlasted, comes back through `ended`.
   */
  begin(ask: MachineUpdateAsk, mode: "idle" | "now", ended: (end: InstallEnd) => void): void;
  close(): void;
}

/** A source checkout: nothing to install, updated with git. */
export function sourceInstaller(): Installer {
  const facts: InstallerFacts = {
    available: null,
    releaseUrl: null,
    blocked: "source",
    phase: "none",
    percent: null,
    error: null,
    checkedAt: null,
    downloadsFirst: false,
  };
  return {
    install: "source",
    facts: () => facts,
    onChange: () => () => {},
    check: async () => {},
    download() {},
    begin(_ask, _mode, ended) {
      ended({ ok: false, error: "This machine runs ace from source.", busy: false });
    },
    close() {},
  };
}

/** The release page of `version` on GitHub. */
export const releasePage = (version: string) =>
  `https://github.com/arpan404/ace/releases/tag/v${version}`;
