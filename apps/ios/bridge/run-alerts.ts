import { z } from "zod";
import type { AutomationRun } from "@ace/protocol";
import {
  batchRunAlerts,
  batchRunAlertsBeyond,
  finishedSince,
  historyPollMs,
  runAlertsShown,
  runAlertTitle,
  runStatusLine,
} from "@ace/ui-core/automations";
import type { KeptValue } from "./kept-value.ts";

/*
 * Automation-run alerts on the phone, as the web's toasts: the machine's recent runs are read
 * every minute while the phone watches (every few seconds while one is going), and each run that
 * finishes is said once. Which runs are news and the words are shared with the web
 * (`@ace/ui-core/automations`); how an alert shows is the notification bridge's.
 */

export interface RunAlert {
  /** The run's id (or "summary:" and the newest folded run's): said once, and the system notification's identifier. */
  key: string;
  title: string;
  /** Its outcome, never its output: a notification can show on a lock screen. */
  body: string;
  /** The thread the run started, which a tap opens; null opens ace. */
  threadId: string | null;
  /** The run's automation; null for a summary of several. */
  automationId: string | null;
}

/** At most this many inbox pages (of 50) are read in one go; past them the rest are counted as "+". */
const maxPages = 20;

type Schedule = (delayMs: number, run: () => void) => () => void;

/**
 * How far this machine's runs have been said, kept between launches: finishes after `since` are
 * news. Null once run alerts were turned off, so the next watch begins afresh.
 */
const Progress = z.object({ since: z.number() }).nullable();

/**
 * One `automation.inbox` page, newest first: only an `ok` one with its inbox is a reading.
 * `before` reads the page after it; null (or absent) when there is none.
 */
export interface InboxReply {
  ok: boolean;
  inbox?: { runs: readonly AutomationRun[]; before?: number | null } | undefined;
}

/** What one go read: the runs back to the cutoff, and whether it got that far. */
interface Reading {
  runs: AutomationRun[];
  /** The inbox had more than one read takes in: older runs it didn't read may have finished too. */
  beyond: boolean;
}

export class RunWatch {
  readonly #read: (before?: number, finishedAfter?: number) => Promise<InboxReply>;
  readonly #schedule: Schedule;
  readonly #now: () => number;
  readonly #say: (alert: RunAlert) => void;
  /** Runs that finished after this are news; unset until watching starts. */
  #since: number | undefined;
  /** Where `since` is kept between launches; none keeps it for this launch only. */
  readonly #kept: KeptValue | undefined;
  /** What is kept was read (or there was nothing to read), so saving can't lose anything. */
  #keepable = false;
  /** Turned off: the next start begins at now, never at what was kept. */
  #forgotten = false;
  readonly #said = new Set<string>();
  #cancel: (() => void) | undefined;
  #running = false;
  /** Bumped by every start and stop: a read from an earlier run is dropped, never scheduled. */
  #run = 0;

  constructor(
    /**
     * Reads an inbox page from `before`, without runs that finished by `finishedAfter`; a refusal
     * or a rejection is a failed read, which changes nothing.
     */
    read: (before?: number, finishedAfter?: number) => Promise<InboxReply>,
    schedule: Schedule,
    now: () => number,
    say: (alert: RunAlert) => void,
    /** This machine's progress, kept on the phone so runs that finish while ace is closed are said. */
    kept?: KeptValue,
  ) {
    this.#read = read;
    this.#schedule = schedule;
    this.#now = now;
    this.#say = say;
    this.#kept = kept;
  }

  /** Reads now, then on the inbox's own cadence, until `stop` or `forget`. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#begin(++this.#run);
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
    this.#forgotten = true;
    this.#keep(null);
  }

  /** Picks up where the last launch left off, or at now, then reads. */
  async #begin(run: number): Promise<void> {
    if (this.#since === undefined) {
      // Read even when turned off, to learn whether saving is safe; its value is then ignored.
      const kept = await this.#restore();
      if (run !== this.#run) return;
      const resumed = this.#forgotten ? undefined : kept;
      this.#since ??= resumed ?? this.#now();
      if (resumed === undefined) this.#keep({ since: this.#since });
    }
    void this.#tick(run);
  }

  /** The kept `since`, if any; a kept value that can't be read is left alone, never saved over. */
  async #restore(): Promise<number | undefined> {
    // Once read, what is kept is this watch's own: there's nothing newer to read back.
    if (!this.#kept || this.#keepable) return undefined;
    try {
      const kept = Progress.safeParse(await this.#kept.load());
      this.#keepable = true;
      return kept.success ? kept.data?.since : undefined;
    } catch {
      return undefined;
    }
  }

  #keep(progress: z.infer<typeof Progress>): void {
    if (this.#keepable) void this.#kept?.save(progress).catch(() => {});
  }

  /**
   * One reading: each run that finished since the cutoff is said once, the newest few by name and
   * the rest counted in one summary ("at least" so many when the reading couldn't take in every
   * page). Every finish is then said or counted, so the cutoff moves past them.
   */
  #see({ runs, beyond }: Reading): void {
    // Only runs still in the inbox can come back; forget the rest.
    const listed = new Set(runs.map((run) => run.id));
    for (const id of this.#said) if (!listed.has(id)) this.#said.delete(id);
    const news = finishedSince(runs, this.#since ?? this.#now(), this.#said);
    for (const run of news) this.#said.add(run.id);
    const batch =
      beyond && news.length > runAlertsShown ? batchRunAlertsBeyond(news) : batchRunAlerts(news);
    for (const run of batch.shown)
      this.#say({
        key: run.id,
        title: runAlertTitle(run),
        body: runStatusLine(run),
        threadId: run.threadId ?? null,
        automationId: run.automationId,
      });
    if (batch.summary) {
      // Keyed by the newest run it folds, so the next pile is a notification of its own.
      const folded = news
        .filter((run) => !batch.shown.includes(run))
        .reduce((a, b) => ((b.finishedAt ?? 0) > (a.finishedAt ?? 0) ? b : a));
      this.#say({
        key: `summary:${folded.id}`,
        title: batch.summary.title,
        body: batch.summary.body,
        threadId: null,
        automationId: null,
      });
    }
    // Every finish since the cutoff is said or counted: carry on from the latest, on the machine's clock.
    const latest = Math.max(...runs.map((run) => run.finishedAt ?? Number.NEGATIVE_INFINITY));
    if (this.#since !== undefined && latest > this.#since) {
      this.#since = latest;
      this.#keep({ since: latest });
    }
  }

  /**
   * Every run that finished since the cutoff, or is still going, a page at a time to the inbox's
   * end: the daemon leaves out runs that finished by the cutoff, so a long run that started early
   * and finished late is found however old its start. A daemon without that filter lists every
   * run, and is read to its end too. Undefined when any page reads nothing, so nothing changes.
   */
  async #collect(): Promise<Reading | undefined> {
    const runs: AutomationRun[] = [];
    const since = this.#since ?? this.#now();
    let before: number | undefined;
    for (let page = 0; page < maxPages; page++) {
      const reply = await this.#read(before, since).catch(() => undefined);
      if (!reply?.ok || !reply.inbox) return undefined;
      runs.push(...reply.inbox.runs);
      const next = reply.inbox.before ?? null;
      if (next === null) return { runs, beyond: false };
      before = next;
    }
    return { runs, beyond: true };
  }

  async #tick(run: number): Promise<void> {
    const reading = await this.#collect();
    if (run !== this.#run) return;
    if (reading) this.#see(reading);
    this.#cancel = this.#schedule(historyPollMs(reading?.runs ?? []), () => void this.#tick(run));
  }
}
