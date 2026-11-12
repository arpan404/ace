import type { AutomationRun } from "@ace/protocol";
import {
  finishedSince,
  historyPollMs,
  runAlertTitle,
  runStatusLine,
} from "@ace/ui-core/automations";

/*
 * Automation-run alerts on the phone, as the web's toasts: the machine's recent runs are read
 * every minute while the phone watches (every few seconds while one is going), and each run that
 * finishes is said once. Which runs are news and the words are shared with the web
 * (`@ace/ui-core/automations`); how an alert shows is the notification bridge's.
 */

export interface RunAlert {
  /** The run's id: said once, and the system notification's identifier. */
  key: string;
  title: string;
  /** Its outcome, never its output: a notification can show on a lock screen. */
  body: string;
  /** The thread the run started, which a tap opens; null opens ace. */
  threadId: string | null;
  automationId: string;
}

type Schedule = (delayMs: number, run: () => void) => () => void;

/** One `automation.inbox` answer: only an `ok` one with its inbox is a reading. */
export interface InboxReply {
  ok: boolean;
  inbox?: { runs: readonly AutomationRun[] } | undefined;
}

/** The runs a reply read, or undefined when it read nothing: refused, or no inbox. */
function reading(reply: InboxReply | undefined): readonly AutomationRun[] | undefined {
  return reply?.ok && reply.inbox ? reply.inbox.runs : undefined;
}

export class RunWatch {
  readonly #read: () => Promise<InboxReply>;
  readonly #schedule: Schedule;
  readonly #now: () => number;
  readonly #say: (alert: RunAlert) => void;
  /** Runs that finished after this are news; unset until watching starts. */
  #since: number | undefined;
  readonly #said = new Set<string>();
  #cancel: (() => void) | undefined;
  #running = false;
  /** Bumped by every start and stop: a read from an earlier run is dropped, never scheduled. */
  #run = 0;

  constructor(
    /** Reads the inbox; a refusal or a rejection is a failed read, which changes nothing. */
    read: () => Promise<InboxReply>,
    schedule: Schedule,
    now: () => number,
    say: (alert: RunAlert) => void,
  ) {
    this.#read = read;
    this.#schedule = schedule;
    this.#now = now;
    this.#say = say;
  }

  /** Reads now, then on the inbox's own cadence, until `stop` or `forget`. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#since ??= this.#now();
    void this.#tick(++this.#run);
  }

  /** Pauses reading (the connection dropped): a run that finishes meanwhile is said on `start`. */
  stop(): void {
    this.#running = false;
    this.#run++;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  /** Stops, and the next `start` begins afresh: runs that finished while alerts were off stay unsaid. */
  forget(): void {
    this.stop();
    this.#since = undefined;
  }

  #see(runs: readonly AutomationRun[]): void {
    // Only runs still in the inbox can come back; forget the rest.
    const listed = new Set(runs.map((run) => run.id));
    for (const id of this.#said) if (!listed.has(id)) this.#said.delete(id);
    for (const run of finishedSince(runs, this.#since ?? this.#now(), this.#said)) {
      this.#said.add(run.id);
      this.#say({
        key: run.id,
        title: runAlertTitle(run),
        body: runStatusLine(run),
        threadId: run.threadId ?? null,
        automationId: run.automationId,
      });
    }
  }

  async #tick(run: number): Promise<void> {
    const runs = reading(await this.#read().catch(() => undefined));
    if (run !== this.#run) return;
    if (runs) this.#see(runs);
    this.#cancel = this.#schedule(historyPollMs(runs ?? []), () => void this.#tick(run));
  }
}
