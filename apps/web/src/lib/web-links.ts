/*
 * Where a web address opens when the person follows a link. ace's own browser comes first: a
 * plain click opens it there whenever the screen has one (a thread's). ⌘-click on a Mac, or
 * Ctrl-click on Windows and Linux, and a middle click always open it in the system's browser
 * instead, a local address (`localhost`, a dev server) included.
 */

export type LinkDestination = "app" | "system";

/** The parts of a click that pick where a link opens. */
export interface LinkClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
}

/** The platform's "open elsewhere" click: ⌘ on Apple, Ctrl elsewhere, or the middle button. */
export function asksForSystemBrowser(click: LinkClick | undefined, apple: boolean): boolean {
  if (!click) return false;
  if (click.button === 1) return true;
  return apple ? click.metaKey : click.ctrlKey;
}

/**
 * Where `url` opens. `inApp` says whether this screen has ace's browser to open it in.
 */
export function linkDestination(input: {
  url: string;
  click: LinkClick | undefined;
  apple: boolean;
  inApp: boolean;
}): LinkDestination {
  if (!input.inApp) return "system";
  return asksForSystemBrowser(input.click, input.apple) ? "system" : "app";
}
