# 0139: Spade is shown or hidden at run time, by a flag in ace's home

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12: "from now onward, when we
release the desktop version for spade, we hide the spade based on daemon flag in .ace folder,
instead of in build"). Amends decision 2 of
[ADR 0123](0123-spade-runs-as-its-own-service.md), which left Spade out of `DISABLE_SPADE=1`
builds (#1782).

## Context

Until Spade launches, releases were built with `DISABLE_SPADE=1`. The flag reached three places:
the web app's Vite define (`VITE_ACE_SPADE`), the daemon bundle (`ACE_BUILD_DISABLE_SPADE`) and
release staging, which left `spade-server` out of the archive and the desktop app. Showing Spade
to one person, or testing a release with Spade, meant a different build, and a release without
`spade-server` could never turn Spade on later without an update.

## Decision

1. **Every build carries Spade.** Releases always stage `spade-server`, and `DISABLE_SPADE`,
   `ACE_BUILD_DISABLE_SPADE` and `VITE_ACE_SPADE` are gone.

2. **`<ACE_HOME>/features.json` decides, on each machine.** The file is a JSON object; Spade is
   shown only when it holds `"spade": true`. It is read leniently: no file is the defaults,
   unknown keys are kept (and kept when ace writes the file), and a file that isn't a JSON
   object, or whose `spade` isn't a boolean, counts as the defaults with one warning in the
   daemon's log until it is fixed. **The default is hidden.** ace had no features or flags file
   in its home before; settings live in SQLite and are per layer, while this is a property of
   one machine's install that a person or a release script should be able to set with a text
   editor, so it is a small file of its own.

3. **The daemon reads it at start and watches it.** Changing the file takes effect at once,
   without a restart; a bad edit hides Spade and a fixed one shows it again.

4. **Hidden means off, without forgetting.** While Spade is hidden the daemon never registers
   Spade's service; if Spade is running it stops it and removes its registration and retires
   its grant, as turning `spade.enabled` off does. It keeps Spade's data folder and leaves
   `spade.enabled` as it is, so showing Spade again applies the setting the way the daemon does
   at start: on registers the service and remakes a grant that was retired, never one the person
   revoked. We chose stopping over leaving the service running: a hidden Spade that keeps working
   in the background, with its grant to ace's tools, is not what a person who can't see it
   expects.

5. **Clients ask the daemon.** `spade.status` gains `hidden: true` while Spade is hidden (absent
   means shown, so older daemons read as shown), with `state: "off"`. `spade.*` requests are
   refused with the new error code `hidden`, and live streams end with reason `hidden`. The web
   and desktop app show only Spade's mark in the rail, as coming soon, leave out its screens and
   its settings page, and follow `spade.status.changed`. A desktop window's direct look at Spade
   (ADR 0124) never overrides a daemon that hides it.

6. **`ace features show spade` / `ace features hide spade`** write the file (bare `ace features`
   prints it). They work with or without a daemon running; a running one notices the change.
   `ace spade on` is refused while Spade is hidden and says how to show it.

## Consequences

- A fresh install shows Spade as coming soon until the person (or the owner, for testers) shows
  it. Launching Spade for everyone later is a change to the default, not to the build.
- `ace doctor` reports Spade as hidden when it is and no service is registered.
- Writing `features.json` into a home that has never been used before ace makes it would look
  like an older home and be moved aside on first start; `ace features` prepares the home first,
  so use it rather than creating the file by hand on a machine where ace hasn't run.
- The iPhone app still hides Spade's tab at build time (`HomeTabs.showsSpade`); reading
  `hidden` from the machine's `spade.status` there is follow-up work.
