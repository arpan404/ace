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

/** At most this many inbox pages (of 50) are read in one go. */
const maxPages = 20;
/** Runs said that finished after the cutoff, kept so a relaunch never says them again. */
const maxSaid = 2_000;

type Schedule = (delayMs: number, run: () => void) => () => void;

/**
 * How far this machine's runs have been said, kept between launches. Null once run alerts were
 * turned off, so the next watch begins afresh. Parts a build before them didn't keep read as empty.
 */
const Progress = z
  .object({
    /** Finishes after this are news. */
    since: z.number(),
    /**
     * A read of a daemon that lists every run, stopped at the page cap before the inbox's end:
     * the next read carries on from `before`. `top` is the newest finish its first read saw, where
     * the cutoff goes once the scan reaches the end.
     */
    scan: z.object({ before: z.number().int().positive(), top: z.number() }).nullable().catch(null),
    /** Runs already said that finished after `since`, with their finish times. */
    said: z
      .array(z.tuple([z.string(), z.number()]))
      .max(maxSaid)
      .catch([]),
  })
  .nullable();
type Scan = { before: number; top: number } | null;

/**
 * One `automation.inbox` page, newest first: only an `ok` one with its inbox is a reading.
 * `before` reads the page after it; null (or absent) when there is none.
 */
export interface InboxReply {
  ok: boolean;
  inbox?: { runs: readonly AutomationRun[]; before?: number | null } | undefined;
}

/** What one go read, and where the inbox goes on from: null once it reached the end. */
interface Reading {
  runs: AutomationRun[];
  next: number | null;
}

export class RunWatch {
  readonly #read: (before?: number, finishedAfter?: number) => Promise<InboxReply>;
  readonly #schedule: Schedule;
  readonly #now: () => number;
  readonly #say: (alert: RunAlert) => void;
  /** Runs that finished after this are news; unset until watching starts. */
  #since: number | undefined;
  /** Where an unfinished scan of a daemon without the filter carries on. */
  #scan: Scan = null;
  /** Runs said that finished after `since`, by id, with their finish times. */
  readonly #said = new Map<string, number>();
  /** Where progress is kept between launches; none keeps it for this launch only. */
  readonly #kept: KeptValue | undefined;
  /** What is kept was read (or there was nothing to read), so saving can't lose anything. */
  #keepable = false;
  /** Turned off: the next start begins at now, never at what was kept. */
  #forgotten = false;
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
    this.#scan = null;
    this.#said.clear();
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
      if (resumed) {
        this.#since = resumed.since;
        this.#scan = resumed.scan;
        for (const [id, at] of resumed.said) this.#said.set(id, at);
      } else {
        this.#since = this.#now();
        this.#save();
      }
    }
    void this.#tick(run);
  }

  /** What was kept, if anything; a kept value that can't be read is left alone, never saved over. */
  async #restore(): Promise<z.infer<typeof Progress> | undefined> {
    // Once read, what is kept is this watch's own: there's nothing newer to read back.
    if (!this.#kept || this.#keepable) return undefined;
    try {
      const kept = Progress.safeParse(await this.#kept.load());
      this.#keepable = true;
      return kept.success ? kept.data : undefined;
    } catch {
      return undefined;
    }
  }

  #save(): void {
    if (this.#since === undefined) return;
    this.#keep({ since: this.#since, scan: this.#scan, said: [...this.#said] });
  }

  #keep(progress: z.infer<typeof Progress>): void {
    if (this.#keepable) void this.#kept?.save(progress).catch(() => {});
  }

  /**
   * One reading: each run that finished since the cutoff is said once, the newest few by name and
   * the rest counted in one summary. The cutoff then moves past every finish said or counted:
   * at once when the daemon left out runs that finished by the cutoff ("at least" so many when the
   * reading couldn't take in every page), and only once a scan of a daemon listing every run
   * reaches the inbox's end, carrying on from where each read stopped.
   */
  #see({ runs, next }: Reading): void {
    const since = this.#since ?? this.#now();
    const news = finishedSince(runs, since, new Set(this.#said.keys()));
    for (const run of news) this.#said.set(run.id, run.finishedAt ?? since);
    // A daemon that ignores `finishedAfter` lists runs that finished by the cutoff.
    const listsEvery = runs.some((run) => run.finishedAt !== undefined && run.finishedAt <= since);
    const beyond = next !== null && !listsEvery;
    this.#announce(news, beyond);
    const latest = Math.max(...runs.map((run) => run.finishedAt ?? Number.NEGATIVE_INFINITY));
    const scan = this.#scan;
    if (next !== null && listsEvery) {
      // Not at the end yet: carry on from here next read, the cutoff where it is till then.
      this.#scan = { before: next, top: scan?.top ?? latest };
    } else {
      this.#scan = null;
      const reached = scan?.top ?? latest;
      if (reached > since) this.#since = reached;
    }
    const cutoff = this.#since ?? since;
    for (const [id, at] of this.#said) if (at <= cutoff) this.#said.delete(id);
    // Past the cap, the oldest said go first: they are the least likely to come back.
    for (const [id] of [...this.#said].toSorted((a, b) => a[1] - b[1])) {
      if (this.#said.size <= maxSaid) break;
      this.#said.delete(id);
    }
    if (news.length || scan !== this.#scan || cutoff !== since) this.#save();
  }

  /** The newest few runs by name, then the rest in one summary. */
  #announce(news: readonly AutomationRun[], beyond: boolean): void {
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
    if (!batch.summary) return;
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

  /**
   * The runs that finished since the cutoff, or are still going, a page at a time: from the newest,
   * or from where an unfinished scan stopped, to the inbox's end or the page cap. The daemon leaves
   * out runs that finished by the cutoff, so a long run that started early and finished late is
   * found however old its start. Undefined when any page reads nothing, so nothing changes.
   */
  async #collect(): Promise<Reading | undefined> {
    const runs: AutomationRun[] = [];
    const since = this.#since ?? this.#now();
    let before = this.#scan?.before;
    for (let page = 0; page < maxPages; page++) {
      const reply = await this.#read(before, since).catch(() => undefined);
      if (!reply?.ok || !reply.inbox) return undefined;
      runs.push(...reply.inbox.runs);
      const next = reply.inbox.before ?? null;
      if (next === null) return { runs, next: null };
      before = next;
    }
    return { runs, next: before ?? null };
  }

  async #tick(run: number): Promise<void> {
    const reading = await this.#collect();
    if (run !== this.#run) return;
    if (reading) this.#see(reading);
    this.#cancel = this.#schedule(historyPollMs(reading?.runs ?? []), () => void this.#tick(run));
  }
}
