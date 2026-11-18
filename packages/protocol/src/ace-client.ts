import { z } from "zod";

/**
 * Which ace app is calling ace cloud or the market, and at which version (ADR 0189). The
 * servers turn a new feature on only for apps whose version supports it, so a beta can use a
 * server feature on the one shared production without stable apps ever seeing it.
 *
 * The value is `<app>/<version>`, e.g. `desktop/0.0.24-beta.1` or `daemon/0.0.23`. `version` is
 * the app's semver (a beta carries its prerelease, ADR 0177), or `development` for a build that
 * isn't a release. Apps outside a browser send it in the `ace-client` header. Browser callers
 * (the web app, the desktop app's renderer) send it only in the `ace-client` query parameter, on
 * every request and upgrade: a WebSocket upgrade can't set headers, and a custom header on a
 * cross-origin call adds a CORS preflight an older cloud refuses.
 *
 * The servers read it leniently: a missing, unknown or garbled value is an unknown client and is
 * still served exactly as before; it only gets no gated feature.
 */
export const ACE_CLIENT_HEADER = "ace-client";
/** The same value on a browser request's or upgrade's URL. */
export const ACE_CLIENT_PARAM = "ace-client";

/** The apps that name themselves. A value naming any other app is an unknown client. */
export const AceClientApp = z.enum(["daemon", "desktop", "web", "ios", "cli", "spade"]);
export type AceClientApp = z.infer<typeof AceClientApp>;

/** A build that isn't a release: run from a checkout, or a local build. */
export const ACE_CLIENT_DEVELOPMENT = "development";

/** The whole value. Longer or differently shaped values are unknown clients. */
export const AceClient = z
  .string()
  .max(96)
  .regex(
    new RegExp(
      `^(?:${AceClientApp.options.join("|")})/(?:${ACE_CLIENT_DEVELOPMENT}|\\d{1,9}\\.\\d{1,9}\\.\\d{1,9}(?:-[a-z0-9.]+)?)$`,
    ),
  );
export type AceClient = z.infer<typeof AceClient>;
