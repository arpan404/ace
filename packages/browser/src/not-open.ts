/**
 * The daemon's refusal of a request for a thread whose browser isn't running: none was opened
 * yet, or it closed, or the daemon restarted since. A viewer reads it as "no browser", not as a
 * failure to reach the machine.
 */
export const browserNotOpen = "Browser session not open";

/** Whether a refused request's error is `browserNotOpen`. */
export const isBrowserNotOpen = (error: string | undefined): boolean => error === browserNotOpen;
