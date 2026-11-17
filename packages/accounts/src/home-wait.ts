/*
 * A session bound to an account whose home folder hasn't answered startup's check waits for that
 * check, never for another account (ADR 0175). It says so once the wait is noticeable, and gives
 * up visibly when the folder stays silent; the check keeps running, so a later send just works.
 */

/** A wait shorter than this goes unmentioned: a healthy folder answers in milliseconds. */
export const homeWaitNoticeMs = 2_000;
/** How long a session waits for a silent folder before its turn fails with the reason. */
export const homeWaitLimitMs = 60_000;

/** The folder of the account a session needs hasn't answered; the turn did not start. */
export class AccountHomeUnanswered extends Error {
  readonly code = "account_home_unanswered";
  readonly title: string;
  readonly detail: string;
  constructor(labels: readonly string[]) {
    const title = `The folder of ${names(labels)} isn't answering, so ace didn't start this turn on it or on another account.`;
    super(title);
    this.name = "AccountHomeUnanswered";
    this.title = title;
    this.detail =
      "ace keeps checking the folder. Once its disk or network share answers, send again and the turn starts on this account.";
  }
}

/** What a thread reads while its session waits: which account, and that nothing else is used. */
export function homeWaitText(labels: readonly string[]): string {
  return `Waiting for the folder of ${names(labels)} to answer. The turn starts on this account once it does.`;
}

function names(labels: readonly string[]): string {
  const quoted = labels.map((label) => `“${label}”`);
  if (quoted.length <= 1) return `the account ${quoted[0] ?? ""}`.trim();
  return `the accounts ${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

export interface HomeWait {
  /** Accounts the session needs whose homes are still being checked, with their names. */
  waiting: readonly { id: string; label: string }[];
  checked(id: string): Promise<void>;
  signal: AbortSignal;
  /** Runs `run` after `ms`; returns a cancel. */
  after(ms: number, run: () => void): () => void;
  /** Called once, when the wait has lasted `noticeMs`. */
  onWaiting?(labels: readonly string[]): void;
  noticeMs?: number;
  limitMs?: number;
}

/** Settles once every waited-for home answers; rejects on abort or once the limit passes. */
export function awaitAccountHomes(wait: HomeWait): Promise<void> {
  if (!wait.waiting.length) return Promise.resolve();
  const labels = wait.waiting.map(({ label }) => label);
  return new Promise<void>((resolve, reject) => {
    const stops: (() => void)[] = [];
    const finish = (settle: () => void) => {
      for (const stop of stops) stop();
      wait.signal.removeEventListener("abort", aborted);
      settle();
    };
    const aborted = () => finish(() => reject(wait.signal.reason));
    if (wait.signal.aborted) return aborted();
    wait.signal.addEventListener("abort", aborted, { once: true });
    stops.push(
      wait.after(wait.noticeMs ?? homeWaitNoticeMs, () => wait.onWaiting?.(labels)),
      wait.after(wait.limitMs ?? homeWaitLimitMs, () =>
        finish(() => reject(new AccountHomeUnanswered(labels))),
      ),
    );
    Promise.all(wait.waiting.map(({ id }) => wait.checked(id))).then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
