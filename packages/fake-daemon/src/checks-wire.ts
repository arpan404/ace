import type {
  DiagnosticRepair,
  DiagnosticReport,
  DiagnosticsRun,
  ProviderStatus,
  Toolchain,
} from "@ace/protocol";

type Operation = "doctor" | "fix";
type Outcome = { report: DiagnosticReport; repairs?: DiagnosticRepair[] };
type Answer = Outcome | { toolchains: Toolchain[] } | { run: DiagnosticsRun } | { error: string };

/**
 * The fake daemon's checks (`diagnostics.request`): one run at a time for every connection, a
 * second request for it joins it, `status` reads it and `join` waits for one run by its id, as
 * the daemon does. `hold` keeps the
 * next run going until the test lets it finish.
 */
export class FakeChecks {
  readonly #now: () => number;
  readonly #providers: () => readonly ProviderStatus[];
  #run: Exclude<DiagnosticsRun, { state: "running" }> = { state: "idle" };
  #pending:
    | { id: string; operation: Operation; startedAt: number; outcome: Promise<Outcome> }
    | undefined;
  #last: { id: string; outcome: Outcome | Promise<Outcome> } | undefined;
  #held: Promise<void> | undefined;
  #sequence = 0;
  /** How many checks runs started, for a test that must see none start again. */
  starts = 0;

  constructor(now: () => number, providers: () => readonly ProviderStatus[]) {
    this.#now = now;
    this.#providers = providers;
  }

  /** The next checks run waits until the returned function is called. */
  hold(): () => void {
    const gate = Promise.withResolvers<void>();
    this.#held = gate.promise;
    return () => gate.resolve();
  }

  answer(
    operation: Operation | "toolchains" | "status" | "join",
    runId?: string,
  ): Answer | Promise<Answer> {
    if (operation === "status") return { run: this.#status() };
    if (operation === "toolchains") return { toolchains };
    if (operation === "join") {
      if (this.#pending && this.#pending.id === runId) return this.#pending.outcome;
      return this.#last && this.#last.id === runId
        ? this.#last.outcome
        : { error: "diagnostics_run_gone" };
    }
    if (this.#pending)
      return this.#pending.operation === operation
        ? this.#pending.outcome
        : { error: "diagnostics_busy" };
    this.starts++;
    const id = `checks-${++this.#sequence}`;
    const startedAt = this.#now();
    const held = this.#held;
    this.#held = undefined;
    const finish = (): Outcome => {
      const result = operation === "fix" ? this.#repaired() : { report: this.#report() };
      this.#run = { state: "done", id, operation, startedAt, finishedAt: this.#now(), ...result };
      this.#pending = undefined;
      this.#last = { id, outcome: result };
      return result;
    };
    // A run that isn't held answers at once, as the fake's other reads do.
    if (!held) return finish();
    const outcome = held.then(finish);
    this.#pending = { id, operation, startedAt, outcome };
    return outcome;
  }

  #status(): DiagnosticsRun {
    if (!this.#pending) return this.#run;
    const { id, operation, startedAt } = this.#pending;
    return {
      state: "running",
      id,
      operation,
      startedAt,
      elapsedMs: Math.max(0, this.#now() - startedAt),
    };
  }

  #report(): DiagnosticReport {
    return {
      at: this.#now(),
      checks: [
        { id: "node", status: "ok", message: "Node v24.0.0", fix: "Update ace." },
        { id: "git", status: "ok", message: "git version 2.50.0", fix: "Install Git." },
        ...this.#providers().map((row) => ({
          id: `provider.${row.provider}`,
          status: row.installed && row.auth === "logged_in" ? ("ok" as const) : ("warn" as const),
          message: row.installed ? "Check provider readiness." : "Not installed.",
          fix: "Open Settings > Providers.",
        })),
        { id: "sqlite", status: "ok", message: "SQLite integrity: ok", fix: "Restore a backup." },
      ],
    };
  }

  #repaired(): Outcome {
    return {
      repairs: [],
      report: {
        at: this.#now(),
        checks: [
          { id: "node", status: "ok", message: "Node v24.1.0", fix: "Update ace." },
          {
            id: "provider.cursor",
            status: "warn",
            message: "Cursor CLI not installed",
            fix: "Install Cursor CLI.",
          },
        ],
      },
    };
  }
}

const toolchains: Toolchain[] = [
  { id: "git", available: true, detail: "git version 2.50.0", hint: "Install Git." },
  {
    id: "xcode",
    available: true,
    detail: "Xcode at /Applications/Xcode.app/Contents/Developer",
    hint: "Install Xcode from the App Store and open it once to set up the iOS Simulator.",
    version: "26.0",
  },
  {
    id: "serve-sim",
    available: true,
    detail: "serve-sim 0.1.49-beta.139.1",
    hint: "Download device tools in Devices: ace keeps its own serve-sim 0.1.49-beta.139.1.",
    version: "0.1.49-beta.139.1",
  },
  {
    id: "android",
    available: false,
    detail: "Android SDK not found",
    hint: "Install Android Studio, then set ANDROID_HOME to its SDK directory.",
  },
];
