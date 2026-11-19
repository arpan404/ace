# 0139: Spade is shown or hidden at run time, by a flag in ace's home

Status: accepted, amended 2026-11-16 (see "Amendment: Settings › Beta"). Date: 2026-11-12. Decided by: the owner (2026-11-12: "from now onward, when we
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

1. **Every build carries Spade.** Releases always stage Spade's binary (now `spade`), and `DISABLE_SPADE`,
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

## Amendment: Settings › Beta (2026-11-16)

Decided by the owner: Spade and the marketplace are switches on Settings › Beta instead of a
flag file. This replaces decisions 2, 3 and 6; decisions 1, 4 and 5 stand, with "hidden" now
meaning "turned off in Beta".

- **One setting per switch.** `beta.spade` and `beta.marketplace` are global daemon settings,
  admin only, that default to `false`, stored in the global `settings.json` with the Beta page's
  other settings. A workspace or thread layer can't set them. The daemon follows `beta.spade`
  through its settings subscription, so a change applies at once, as the file watch did.
- **`features.json` is folded in once.** On start, off the start path (ADR 0170), the daemon
  reads `features.json`: `"spade": true` turns `beta.spade` on unless the person already set it,
  then the `spade` key leaves the file (the file goes when nothing else is in it), so a later
  "off" is never undone. A file that isn't a JSON object is left alone. Until a daemon has run,
  read-only readers (`ace doctor`, `ace features`, `ace spade on`, the updater's service guard
  in `@ace/service`) still count an unfolded `"spade": true` as on. One reader,
  `@ace/settings/beta`, does both. A home holding only `features.json` still counts as new.
- **`ace features`** prints both switches; `ace features on|off spade|marketplace` saves them,
  through a running daemon or into the home when none runs. `show` and `hide` are gone.
  `ace spade on` is refused while Beta has Spade off.
- **The marketplace off** hides every way in on the client (its rail place, the palette, Spade's
  apps button, New bot's link, Appearance's "More Suits", the Skills Add menu) and sends its
  addresses home. The daemon answers every `marketplace.request` with `unavailable` and a message
  saying it is turned off, and its daily refresh skips the network. What was installed from the
  marketplace keeps working: Suits, skills and plugins run from their own services.
- An older build reading a home whose flag was folded sees no `features.json` and hides Spade
  until it is shown again there.
