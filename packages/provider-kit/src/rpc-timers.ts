export type DeadlineScheduler = (delayMs: number, callback: () => void) => () => void;

/** Default timer boundary; callers can inject deterministic deadlines. */
export const scheduleDeadline: DeadlineScheduler = (delayMs, callback) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};
