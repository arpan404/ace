import type {
  MachineUpdate,
  MachineUpdateRequest,
  MachineUpdateResult,
  ServerMessage,
} from "@ace/protocol";

/**
 * `machineUpdate.request` in memory: this fake machine's version, the release on offer and a
 * scripted update. `start` waits for its agents (`busy`, one finishing per step) when asked
 * for idle, then downloads in two steps, restarts and reports updated; a seeded `fails` makes
 * the download fail instead. Tests call `step()`; dev:fake runs it on a timer (`autoplay`).
 * Every connection that read the status hears each change, as the daemon tells its watchers.
 * Refusing non-administrators is `request-scopes.ts`'s, as it is the daemon's admission.
 */
export class FakeMachineUpdate {
  private status: MachineUpdate = {
    version: "0.0.18",
    platform: "darwin",
    arch: "arm64",
    install: "desktop",
    state: "none",
    available: null,
    releaseUrl: null,
    blocked: null,
    ask: null,
    busy: 0,
    percent: null,
    error: null,
    last: null,
    checkedAt: null,
  };
  private fails: string | null = null;
  private asks = 0;
  private readonly watchers = new Set<(message: ServerMessage) => void>();
  private timer: { set(delayMs: number, callback: () => void): () => void } | undefined;
  private stepMs = 1500;
  private pending: (() => void) | undefined;
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  /** Set what the machine reports; `fails` makes its next download fail with those words. */
  seed(fields: Partial<MachineUpdate>, options: { fails?: string | null } = {}): void {
    if (options.fails !== undefined) this.fails = options.fails;
    this.put(fields);
  }
  get(): MachineUpdate {
    return this.status;
  }
  /** Run the scripted update on `timer`, a step every `stepMs`. */
  autoplay(timer: { set(delayMs: number, callback: () => void): () => void }, stepMs = 1500): void {
    this.timer = timer;
    this.stepMs = stepMs;
    this.schedule();
  }
  /** One step of the update in progress; false when there's none. */
  step(): boolean {
    const status = this.status;
    switch (status.state) {
      case "waiting":
        if (status.busy > 1) this.put({ busy: status.busy - 1 });
        else this.put({ busy: 0, state: "downloading", percent: 0 });
        return true;
      case "downloading": {
        if (this.fails) {
          const error = this.fails;
          this.fails = null;
          this.put({
            state: "failed",
            error,
            percent: null,
            ask: null,
            last: {
              from: status.version,
              to: status.ask?.version ?? status.version,
              ok: false,
              error,
              at: this.now(),
            },
          });
          return true;
        }
        const percent = (status.percent ?? 0) + 50;
        this.put(percent >= 100 ? { state: "ready", percent: null } : { percent });
        return true;
      }
      case "ready":
        this.put({ state: "installing" });
        return true;
      case "installing": {
        const to = status.ask?.version ?? status.available ?? status.version;
        this.put({
          version: to,
          state: "updated",
          available: null,
          ask: null,
          error: null,
          last: { from: status.version, to, ok: true, error: null, at: this.now() },
        });
        return true;
      }
      default:
        return false;
    }
  }
  session(emit: (message: ServerMessage) => void) {
    return {
      handle: (message: MachineUpdateRequest) => emit(this.request(message, emit)),
      close: () => {
        this.watchers.delete(emit);
      },
    };
  }
  private request(
    message: MachineUpdateRequest,
    emit: (message: ServerMessage) => void,
  ): MachineUpdateResult {
    const reply = (ok: boolean, error?: string): MachineUpdateResult => ({
      type: "machineUpdate.result",
      requestId: message.requestId,
      ok,
      update: this.status,
      ...(error ? { error } : {}),
    });
    switch (message.operation) {
      case "status":
        this.watchers.add(emit);
        return reply(true);
      case "check":
        this.put({ checkedAt: this.now() });
        return reply(true);
      case "cancel":
        if (["waiting", "downloading", "ready"].includes(this.status.state))
          this.put({ state: "available", ask: null, percent: null });
        return reply(true);
      case "start": {
        const { mode, version } = message;
        if (!mode || !version) return reply(false, "invalid");
        if (this.status.blocked) return reply(false, "blocked");
        if (version !== this.status.available) return reply(false, "stale");
        if (mode === "now" && this.status.busy > (message.agents ?? 0))
          return reply(false, "confirm");
        const ask = { id: `ask-${++this.asks}`, mode, version, requestedAt: this.now() };
        const waits = mode === "idle" && this.status.busy > 0;
        this.put({
          ask,
          state: waits ? "waiting" : "downloading",
          percent: waits ? null : 0,
          error: null,
        });
        return reply(true);
      }
    }
  }
  private put(fields: Partial<MachineUpdate>): void {
    this.status = { ...this.status, ...fields };
    const changed: ServerMessage = { type: "machineUpdate.changed", update: this.status };
    for (const send of this.watchers) send(changed);
    this.schedule();
  }
  private schedule(): void {
    if (!this.timer || this.pending) return;
    if (!["waiting", "downloading", "ready", "installing"].includes(this.status.state)) return;
    this.pending = this.timer.set(this.stepMs, () => {
      this.pending = undefined;
      this.step();
    });
  }
}
