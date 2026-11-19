import type { AccountRefusal } from "./scheduler.ts";

/*
 * Why an account can't take work, in words an agent can pass on to the person ("Codex account
 * 346 is at its limit until 4:10 PM CDT"). Pure: callers pass the clock and time zone.
 */

const day = 86_400_000;

/** "4:10 PM CDT", or "Mon, Nov 2, 4:10 PM CST" when it is a day or more away. */
export function resetClock(at: number, now: number, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(at - now >= day ? { weekday: "short", month: "short", day: "numeric" } : {}),
  };
  try {
    return new Intl.DateTimeFormat("en-US", options).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(at);
  }
}

/**
 * One sentence saying why `name` ("Codex account 346") can't take work. `other_provider` is worded
 * by the caller, which knows the provider the account really belongs to.
 */
export function refusalWords(
  name: string,
  refusal: AccountRefusal,
  now: number,
  timeZone: string,
): string {
  switch (refusal.reason) {
    case "at_limit":
      return refusal.until === null
        ? `${name} is at its limit; the provider didn't say when it resets`
        : `${name} is at its limit until ${resetClock(refusal.until, now, timeZone)}`;
    case "signed_out":
      return `${name} is signed out; the person signs it in again in Settings`;
    case "home_unavailable":
      return `${name} can't be used: its home folder is missing or unreadable`;
    case "sign_in_unconfirmed":
      return `${name} hasn't confirmed it is signed in yet`;
    case "other_provider":
      return `${name} belongs to another provider`;
  }
}
