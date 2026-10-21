/**
 * Launching the desktop app with this asks it to find, download and install its update
 * (ADR 0091). `ace update apply` from the CLI bundled in the app passes it; the app reads it
 * at launch and from a second instance. Its own module so the app's startup bundle stays small.
 */
export const desktopUpdateArgument = "--ace-update";
