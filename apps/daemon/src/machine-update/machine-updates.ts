import type { MachineUpdate, MachineUpdateRequest, MachineUpdateResult } from "@ace/protocol";
import type { InstallEnd, Installer } from "./installer.ts";
import type { RecordStore, UpdateRecord } from "./record.ts";
import { machineStatus, nextStep, settleInstall, startRefusal } from "./rules.ts";

export interface MachineUpdatesOptions {
  installer: Installer;
  record: RecordStore;
  /** The running version, platform and architecture. */
  version: string;
  platform: string;
  arch: string;
  /** Threads at work or waiting on a person (the maintenance gate's blockers). */
  busy(): number;
  /** Calls `listener` when `busy` may have changed; returns the unsubscribe. */
  watchBusy(listener: () => void): () => void;
  now(): number;
  id(): string;
  log(error: unknown): void;
}

type Answer = Omit<
  Extract<MachineUpdateResult, { type: "machineUpdate.result" }>,
  "type" | "requestId"
>;

/**
 * This machine's update, carried out on an administrator's request (ADR 0113). It holds the
 * request durably, so a restart in the middle neither loses it nor repeats an install: an
 * install is recorded before it begins, and the daemon that starts afterwards settles it by the
 * version it runs. Every change goes through `#evaluate`, which asks the rules for one step.
 */
export class MachineUpdates {
  readonly #options: MachineUpdatesOptions;
  #record: UpdateRecord = { ask: null, installing: null, last: null };
  #downloadAsked: string | undefined;
  #saving: Promise<void> = Promise.resolve();
  #last = "";
  #stops: (() => void)[] = [];
  readonly #listeners = new Set<(update: MachineUpdate) => void>();

  constructor(options: MachineUpdatesOptions) {
    this.#options = options;
  }

  /** Loads the record, settles an install the last daemon started, then follows changes. */
  async start(): Promise<void> {
    const { record, installer, version } = this.#options;
    this.#record = await record.load();
    const installing = this.#record.installing;
    if (installing) {
      const outcome = await record.takeOutcome();
      const settled = settleInstall({
        installing,
        running: version,
        outcome,
        at: this.#options.now(),
      });
      this.#record = {
        ask: settled.retry ? this.#record.ask : null,
        installing: null,
        last: settled.last,
      };
      await this.#save();
    }
    this.#stops.push(
      installer.onChange(() => this.#evaluate()),
      this.#options.watchBusy(() => this.#evaluate()),
    );
    this.#evaluate();
  }

  current(): MachineUpdate {
    const { installer, version, platform, arch } = this.#options;
    return machineStatus({
      version,
      platform,
      arch,
      install: installer.install,
      facts: installer.facts(),
      ask: this.#record.ask,
      installing: this.#record.installing,
      last: this.#record.last,
      busy: this.#options.busy(),
    });
  }

  onChange(listener: (update: MachineUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Carries out a client's request; the caller has checked its scope. */
  async handle(request: MachineUpdateRequest): Promise<Answer> {
    const { installer } = this.#options;
    if (request.operation === "check") await installer.check();
    else if (request.operation === "cancel") {
      if (this.#record.ask && !this.#record.installing) {
        this.#record = { ...this.#record, ask: null };
        await this.#save();
      }
    } else if (request.operation === "start") {
      const refusal = startRefusal({
        request,
        facts: installer.facts(),
        busy: this.#options.busy(),
      });
      if (refusal) return { ok: false, error: refusal, update: this.current() };
      if (!this.#record.installing) {
        this.#record = {
          ...this.#record,
          ask: {
            id: this.#options.id(),
            mode: request.mode ?? "idle",
            version: request.version ?? "",
            requestedAt: this.#options.now(),
          },
        };
        await this.#save();
      }
    }
    this.#evaluate();
    return { ok: true, update: this.current() };
  }

  close(): void {
    for (const stop of this.#stops.splice(0)) stop();
    this.#options.installer.close();
  }

  #evaluate(): void {
    const { installer } = this.#options;
    const { ask } = this.#record;
    const step = nextStep({
      ask,
      facts: installer.facts(),
      busy: this.#options.busy(),
      installing: this.#record.installing,
    });
    if (ask && step.kind === "download" && this.#downloadAsked !== ask.id) {
      this.#downloadAsked = ask.id;
      installer.download(ask);
    } else if (ask && step.kind === "install") {
      const installing = {
        from: this.#options.version,
        to: ask.version,
        mode: step.mode,
        at: this.#options.now(),
      };
      this.#record = { ...this.#record, installing };
      // Recorded before it begins: the daemon after the restart settles it by its version.
      void this.#save().then(() =>
        installer.begin(ask, step.mode, (end) => this.#ended(ask.id, end)),
      );
    } else if (ask && step.kind === "expire") {
      this.#record = {
        ask: null,
        installing: null,
        last: {
          from: this.#options.version,
          to: ask.version,
          ok: false,
          error: step.error,
          at: this.#options.now(),
        },
      };
      void this.#save();
    }
    this.#tell();
  }

  /** The install ended and this daemon is still here: it didn't happen. */
  #ended(askId: string, end: InstallEnd): void {
    const installing = this.#record.installing;
    if (!installing || this.#record.ask?.id !== askId) return;
    const retry = end.busy && installing.mode === "idle";
    this.#record = {
      ask: retry ? this.#record.ask : null,
      installing: null,
      last: {
        from: installing.from,
        to: installing.to,
        ok: false,
        error: end.error,
        at: this.#options.now(),
      },
    };
    void this.#save();
    this.#evaluate();
  }

  #save(): Promise<void> {
    const snapshot = this.#record;
    this.#saving = this.#saving
      .then(() => this.#options.record.save(snapshot))
      .catch((error: unknown) => this.#options.log(error));
    return this.#saving;
  }

  #tell(): void {
    const update = this.current();
    const key = JSON.stringify(update);
    if (key === this.#last) return;
    this.#last = key;
    for (const listener of this.#listeners) listener(update);
  }
}
