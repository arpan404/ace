import {
  limitAlertWords,
  limitChanges,
  nextLimitReset,
  type AccountView,
  type LimitReading,
} from "@ace/ui-core";

/*
 * Usage-limit alerts on the phone, as the web's toasts: the machine's accounts are read every
 * minute while the phone watches, and again just after the next reset of a window near or at its
 * limit, and each change (near, reached, can work again) is said once. The words and the judging
 * are shared with the web (`@ace/ui-core`); how an alert shows is the notification bridge's.
 */

export interface LimitAlert {
  /** The change's own key: said once, and the system notification's identifier. */
  key: string;
  title: string;
  body: string;
}

type Schedule = (delayMs: number, run: () => void) => () => void;

/** How often quota is read: the daemon pushes no quota changes. */
const refreshMs = 60_000;
/** Read this long past a reset, for the provider to catch up. */
const resetGraceMs = 2_000;
/** Changes already said, by window period; forgotten past this many. */
const remembered = 256;

export class LimitWatch {
  readonly #read: () => Promise<readonly AccountView[]>;
  readonly #schedule: Schedule;
  readonly #now: () => number;
  readonly #say: (alert: LimitAlert) => void;
  #reading: LimitReading | undefined;
  readonly #said = new Set<string>();
  #cancel: (() => void) | undefined;
  #running = false;
  /** Bumped by every start and stop: a read from an earlier run is dropped, never scheduled. */
  #run = 0;

  constructor(
    read: () => Promise<readonly AccountView[]>,
    schedule: Schedule,
    now: () => number,
    say: (alert: LimitAlert) => void,
  ) {
    this.#read = read;
    this.#schedule = schedule;
    this.#now = now;
    this.#say = say;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Reads now, then every minute and just after the next reset, until `stop`. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#tick(++this.#run);
  }

  stop(): void {
    this.#running = false;
    this.#run++;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  /** One fresh reading: each change it announces is said once. */
  see(views: readonly AccountView[]): void {
    const now = this.#now();
    const { changes, reading } = limitChanges(this.#reading, views, now);
    this.#reading = reading;
    for (const change of changes) {
      if (this.#said.has(change.key)) continue;
      if (this.#said.size >= remembered) this.#said.clear();
      this.#said.add(change.key);
      const words = limitAlertWords(change, now);
      this.#say({ key: change.key, title: words.title, body: words.description });
    }
  }

  async #tick(run: number): Promise<void> {
    const views = await this.#read().catch(() => undefined);
    if (run !== this.#run) return;
    if (views) this.see(views);
    const now = this.#now();
    const reset = views ? nextLimitReset(views, now) : undefined;
    const delay =
      reset === undefined
        ? refreshMs
        : Math.min(refreshMs, Math.max(0, reset - now) + resetGraceMs);
    this.#cancel = this.#schedule(delay, () => void this.#tick(run));
  }
}
