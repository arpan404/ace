# 0174: The market's publishers, discovery and scanning

Status: proposed. Date: 2026-11-16. Decided by: the owner (2026-11-16: publisher profiles,
trending and discovery, publishing from the app, publishers managing their own publications, and
a scan pipeline that blocks malware and harmful entries automatically; the same day: Workers, D1
and R2 only; publishing only ever as an authenticated ace account; contracts in
`@ace/protocol`; then, before any data was stored: a D1 database per entry type and per shared
domain, decision 16). Amends [ADR 0168](0168-ace-marketplace.md) (the marketplace) and builds on
[ADR 0111](0111-account-machine-access.md) (account grants), [ADR 0150](0150-suits.md) (Suits),
[ADR 0014](0014-plugins.md) (plugins), [ADR 0167](0167-spade-security-boundaries.md) (what a
bot is granted), [ADR 0171](0171-spade-decides-on-effects.md) and
[ADR 0172](0172-spade-classifies-calls-with-its-own-model.md) (Spade's effect rules and its own
classifier), and [ADR 0125](0125-validate-at-trust-boundaries.md).

## Context

ADR 0168 phase 1 built `market.acehq.dev` (`apps/market`, D1 and R2), the shared checks in
`@ace/marketplace`, the signer and the daemon's client. A publisher can upload a version from the
CLI and withdraw it; that's all. The Worker serves the API only: the public web page ADR 0168
first described was removed at the owner's request (2026-11-16), so every "page" below (a
publisher's, an entry's, a review) is a view inside the ace app. The owner now wants:

- publishers with public profiles, and a page of their own with every entry's state;
- Discover: a hero, Trending this week, New and notable, collections and top publishers;
- publishing from the app, with drafts, the server's checks as plain sentences, then publish;
- publishers managing their publications fully: listing edits, versions, visibility, pins,
  transfers, archiving, their own signals and appeals;
- **harmful entries blocked automatically.** Anything that might carry malware or a harmful
  program is refused, and suspicious Suits, skills, tools and plugins are held or refused;
- **writes only as an authenticated ace account**, checked on every request.

ADR 0168's checks are about format: schemas, paths, limits, ADR 0150's static Suit checks and
secrets. Nothing reads what a script does.

## Decision

### 1. Only Workers, D1 and R2

- **Compute is the Worker** (`ace-market`); its cron (every 15 minutes) does background work:
  folding download counts, trending, scan steps that didn't fit a request, pruning.
- **All data is in D1**, split across several databases (decision 16); **all bytes are in R2**, under prefixes that say what they are:

  | Prefix                 | Holds                                                             | Deleted?                    |
  | ---------------------- | ----------------------------------------------------------------- | --------------------------- |
  | `objects/<hash>`       | A submitted version's archive (ADR 0168), served only once listed | Never once a version listed |
  | `drafts/<id>/<hash>`   | A draft's archive, one key per revision                           | With the draft or revision  |
  | `avatars/<sha256>`     | A publisher's picture, validated and stripped (decision 3)        | When no profile names it    |
  | `previews/<sha256>`    | An entry's listing pictures                                       | When no listing names it    |
  | `reports/<kind>/…json` | A scan report (decision 8), per draft revision or version         | A draft's, with the draft   |

- No KV, Durable Objects, Queues or outside service. Rate limits use the Workers rate-limit
  bindings (in memory, ADR 0168 §10).

### 2. Writes only as an authenticated ace account

Every write (drafts, uploads, publish, listing and profile edits, avatar, previews, versions,
visibility, pins, transfers, archive, withdraw, appeals) needs a valid **market grant** in
`Authorization: Bearer`. Reads, and the anonymous abuse report (decision 7), stay open. There is
no anonymous write and no other credential.

- **Minted by the account backend only.** `cloud.acehq.dev` mints it (`POST /v1/grants`,
  `purpose: "market-publish"`) for a live ace session (the WorkOS sign-in, refreshed on every
  read, ADR 0111) whose account's email is verified; an unverified email is refused with
  `email_unverified`. The grant lives at most five minutes (`GRANT_LIFETIME_MS`).
- **Its claims** (`MarketGrantClaims`, `@ace/account-grant`): `v`, `kid`, `kind` (machine or
  device), `account` (the WorkOS user id), `subject`, `iat`, `exp`, `aud: "market.acehq.dev"`,
  `purpose: "market-publish"`, `iss` (the backend's host, `cloud.acehq.dev`), `emailVerified`
  and `authAt`, the time the session behind it signed in.
- **Checked on every request**: the signature against the backend's published keys, the
  audience, the purpose, the expiry and lifetime, the issuer against the market's configured one
  (`ACE_GRANT_ISSUER`, default `cloud.acehq.dev`) and `emailVerified: true`. The market refuses
  relay, machine and cloud grants (their parsers are strict, so each is malformed here), and
  every other service refuses the market grant, as ADR 0168 §7 has it.
- **Bound to the account.** The account id names the publisher; every route that touches an
  entry checks the entry's publisher is that account's, on every request.
- **Account state.** A publisher is `active`, `suspended` or `deleted`. A suspended or deleted
  publisher can't write (403, "This account can't publish right now"); a deleted WorkOS user
  gets no grants at all. Maintainers set the state (decision 10) and can withdraw a suspended
  publisher's live entries, which the signer signs as revocations.
- **Signing out or revoking a device** ends the session the backend mints from, so no new grant
  is minted; a grant already out lasts at most five minutes.
- **Sensitive actions need a recent sign-in:** changing the handle, withdrawing a version or an
  entry, transferring an entry (both sides) and editing a verified publisher's profile. The
  grant's `authAt` must be within ten minutes (`reauthMs`), else 401 `reauth`, "Sign in again to
  do this." The backend records each session's sign-in time; sessions from before this change
  count as old.
- **On the device.** The daemon mints the grant through the machine's signed-in ace account for
  each write and holds it only for that request: never on disk, never logged, never sent to a
  client. Signed out, every publishing operation answers `signed_out`, "Sign in to publish."

### 3. Publisher profiles

- **Handle.** ADR 0168's publisher name is the handle: 3 to 32 of `a-z`, `0-9` and single dashes.
  It is unique, and so is its **skeleton** (decision 8's confusable folding: `0→o`, `1→l`,
  `rn→m`, `vv→w` and the like, dashes dropped), so `ace-team` and `acc-tearn` can't both exist.
  Reserved words (`ace`, `acehq`, `admin`, `official`, `support`, `security`, `market`,
  `marketplace`, `spade`, `staff`, `moderator`, `verified`, `root`, `system`, `help`, `api`,
  `www` and the rest of the list in `@ace/marketplace`), compared by skeleton so a lookalike
  (`adm1n`, `ace0fficial`) is caught too, and any handle whose skeleton holds a reserved word as a
  whole dash-separated part are refused; ace's own publisher is seeded. A handle given up is
  retired for its account, so nobody else can take it and pose as them. An active or retired
  handle's skeleton is held in one reservation table whose unique key refuses a second claim at
  the database write, so no stalled or racing request can take a handle another account owns.
- **Fields.** Display name (1 to 60, scanned for hidden unicode and mixed scripts), bio (at most
  500), links (at most 5, `https:` only, no credentials, no IP-literal hosts, at most 2048), the
  avatar, joined date, the **verified-by-ace** mark (decision 13) and up to 6 pinned
  entries.
- **The avatar** is PNG, JPEG or WebP, at most 512 KiB, 64 to 1024 pixels a side, at most 2:1.
  The Worker can't decode pixels without an outside service, so it **validates and strips**
  instead: it parses the container (PNG chunks with their CRCs, JPEG segments, WebP RIFF chunks),
  keeps only the image's own chunks (no text, EXIF, XMP, ICC beyond sRGB, nothing after the end
  marker, no animation), checks the declared dimensions and writes the stripped bytes to
  `avatars/<sha256>`. It is served as its own type with `nosniff` and `immutable`. Listing
  pictures follow the same rules at 320 to 4096 pixels and 1 MiB. A picture's bytes are charged to
  the publisher's storage quota before they are written (so a version or draft upload sees them
  too), a bad listing-picture slot writes nothing, and the cron collects pictures nothing names
  once a grace period has passed, so nothing is left orphaned in R2.
- **A profile is made only from an authenticated account**, on its first publish or by
  `POST /v1/me/profile`; the handle belongs to that account id.

### 4. Your own page

`GET /v1/me` answers the signed-in publisher's profile, entries, drafts and transfers. Each
version has one **status** the page shows:

| Status         | Means                                                             |
| -------------- | ----------------------------------------------------------------- |
| `live`         | Signed and listed, with ace's review mark                         |
| `not-reviewed` | Signed and listed, no review mark                                 |
| `waiting`      | Passed the scan; waiting for the signer, or held for a maintainer |
| `withdrawn`    | Withdrawn by its publisher or revoked by ace, with the reason     |
| `blocked`      | Refused by the scan or a maintainer, with the plain reason        |

A version may also be `deprecated`, with its note, and carries its changelog and its scan
findings as plain sentences.

### 5. Managing publications

All under `/v1/me/…`, all needing the grant, all checking ownership. Published bytes are never
deleted or changed: withdrawal is the only removal of a published version, as in 0168.

- **Drafts.** `POST /v1/me/drafts` takes `{type, name, version}` and the archive; the Worker reads
  it, runs the format checks and the scan (decision 8) and stores it at `drafts/<id>/<hash>`, so a row always names the bytes it scanned. A draft can
  be replaced, given a changelog, deleted, and published. At most 20 per publisher; one untouched
  for 30 days is deleted by the cron.
- **Publishing a draft** (`POST /v1/me/drafts/{id}/publish`) makes the version: a block refuses it
  with the findings (the draft stays, so the publisher can fix it and appeal); a pass or a warn
  stores the archive at `objects/<hash>` and the version waits (`pending` for the signer, `held`
  for a maintainer, decision 9). The CLI's `POST /v1/publish/{type}/{name}/versions` is the same
  in one step; its blocked uploads are recorded as `blocked` versions with their report, so the
  publisher sees why.
- **Listing edits without a version.** `PUT /v1/me/entries/{type}/{name}/listing` sets title,
  line, description, categories, keywords, links and up to 4 pictures. Edits are scanned (hidden
  unicode, links, prompt injection, impersonation). An entry with ace's review mark gets them only
  after a maintainer approves (`pending listing`); others get them at once unless they warn.
- **Changelog per version**, at most 4,000 characters, scanned like the listing.
- **Latest.** `PUT …/latest {version}` names which live version the listing shows and the index
  offers; `null` goes back to the newest. Naming an earlier live version is the rollback.
- **Deprecate** a version with a note (at most 500); devices show it on the entry, on installs and
  on the review. Undeprecate clears it.
- **Withdraw** a version or the whole entry, with a reason (sensitive). The signer signs each into
  the withdrawn list (0168 §6).
- **Delete** a draft, or an entry that never had a listed version, with its unlisted versions.
- **Visibility.** `listed` or `unlisted`. An unlisted entry is left out of the index, search,
  Discover, categories, featured, collections and the publisher's page, and is still answered by
  its entry page, versions and objects, so a direct link installs it.
- **Pins.** `PUT /v1/me/pins` sets up to 6 of the publisher's own listed entries in order.
- **Archive.** An archived entry leaves the profile and the index (no new installs are offered,
  no updates), and people who installed it keep it.
- **Transfer.** `POST …/transfer {to}` (sensitive) offers the entry to another publisher; that
  account accepts with its own recent sign-in (`POST /v1/me/transfers/{id}/accept`) or declines.
  An offer lasts 7 days. Accepting moves the entry, unpins it from the old profile and keeps
  every signed manifest as it was: old versions still name the publisher who published them.
- **Signals, for the publisher only.** `GET …/signals`: anonymous download totals per version per
  day for 90 days, update adoption (the share of the last 30 days' downloads on the latest
  version) and reports received with their outcome. Nothing in them is per person.
- **Appeals.** `POST …/versions/{version}/appeal {note, replacement?}` answers a block or a hold
  with a note and optionally a newer version. Appeals wait in the maintainers' queue.

### 6. Discovery

`GET /v1/discover` answers, in one body: the **hero** (the first featured entry), **featured**,
**Trending this week**, **New and notable**, **collections** and **top publishers**.

- **Download counting stays anonymous** (0168 §10). A fetch of an object adds one to its
  version's total and to an hourly bucket per version (`downloads_hourly`, kept 15 days, then
  folded into `downloads_daily`, kept 400 days). A caller past the `DOWNLOADS` rate-limit binding
  (keyed by address and hash, in memory only) still gets the bytes and isn't counted. For
  **ranking**, identical bytes count once: a fetched hash is credited to the entry that listed it
  first, so the same object published under many versions or entries can't multiply a score. The
  per-version totals a publisher's own signals show are kept as they are.
- **Trending** (`@ace/marketplace`'s `rankTrending`, pure):
  - each entry's hourly counts over the last 7 days are capped twice: an hour above
    `max(50, 4 × the median of its non-empty hours in the 7 days before)` counts only up to that
    cap (a burst that looks automated adds nothing past it), and a day counts at most 5,000;
  - the capped counts decay with a 72-hour half-life and sum to the score;
  - an entry needs at least 5 capped downloads in the week, is listed, visible, not archived and
    its publisher active;
  - movement compares its rank with the same ranking a week earlier: `new`, `up` by n, `down` by
    n or `same`.

  The cron ranks in bounded batches (500 entries a step, a cursor in `meta`) and swaps the
  `trending` table when a pass completes, so no step grows with history.

- **New and notable:** listed, visible entries with ace's review mark whose first listing is
  within 30 days, newest first, at most 24.
- **Collections:** curated by maintainers with `ace market collection …`, uploaded behind the
  signer's token as featured is (0168 §6); at most 16, each with an id, title, one line and at most
  24 entries, shown with only the entries still listed and visible.
- **Top publishers:** active publishers with a listed, reviewed entry, ranked by capped downloads
  over 30 days; at most 12, with handle, display name, avatar, verified mark and counts.
- **Search** on the Worker (`/v1/search`) gains `publisher=`, `sort=relevance|trending|new|
downloads` and `offset`, and never returns unlisted or archived entries. The daemon still
  searches its own copy of the index (0168 §3).
- `GET /v1/publishers/{handle}` is the public profile, with pinned and listed entries.

### 7. Abuse reports

`POST /v1/reports` takes `{type, name, version?, reason, note?}` with `reason` one of `malware`,
`harmful`, `impersonation`, `spam`, `copyright`, `other`, and a note of at most 1,000 characters.
It needs no account and stores no address: the `REPORTS` binding limits callers in memory (5 a
minute), and an entry holds at most 500 open reports. Maintainers work the queue with
`ace market reports`; each ends `dismissed`, `kept`, `withdrawn` or `blocked`, which the
publisher sees in their signals.

### 8. The scan pipeline

Every upload and every listing edit goes through **one scanner**, `@ace/marketplace`'s
`scanEntry` (and `scanListing`), a pure module run in three places on the same bytes:

1. **the Worker**, before a draft can be published or a version stored as waiting;
2. **the signer**, before it signs (`ace market sign` re-runs it on the bytes from R2, with the
   newest blocklist);
3. **the device**, in `prepare`, on the exact bytes it verified against the manifest. The daemon
   refuses a block even when the Worker listed it, and the review page gets every finding.

Each **check** answers `pass`, `warn` or `block` from its findings. A finding has a rule id, a
level (`note`, `warn`, `block`), a path and line when it has one, and one plain sentence the
publisher and the person read ("scripts/setup.sh line 4 downloads a script and runs it"). A
`note` is shown and never holds, except for new publishers (decision 9).

**The scanner fails closed.** Chasing spellings loses; the scanner's standing rule is that
anything **executable or instructional it can't fully resolve is held for a maintainer, never
passed**. Concretely, in executable or instructional content (a script, a plugin command, a
scene, an instruction file, a recipe's text):

- **Unresolved means held.** Code or a command the scanner can't resolve to something it
  understands — a file it can't parse, a shell word it can't read, an unknown program that takes a
  command, a reflective or dynamic read of a sensitive module, execution intent in prose it can't
  tie to a known-safe command — produces a `warn`, which holds the version. A rule proves a thing
  is safe, not that it is dangerous.
- **Truncation means blocked or resumed, never silent.** No cap in the scanner may drop executable
  or instructional content without surfacing it. A cap either resumes across steps (as the
  file budget does) or produces a `scan-truncated` **block**: the entry can't be listed until it is
  read whole. This joins the invariant that a scan which didn't read every file blocks.

A data file that is neither executable nor instructional is exempt: not reading all of a large
image or data blob isn't a gap in what could run. A file the scanner can't decode as text and
whose bytes aren't a recognised inert data format (an image, a font, an audio or video container)
is itself held — the scanner never reads safety from unrecognised magic, so an "unknown binary"
in a skill or plugin holds by default. The fail-closed rules are tested, and the adversarial
corpus carries a sample for each.

**The scanner is a filter, not the boundary.** Static analysis can never be complete, so the real
boundary is runtime containment: a bot runs under the Spade sandbox ([ADR 0167](0167-spade-security-boundaries.md))
with no credentials and the network only through the proxy, and a Suit's scene runs in a
sandboxed, out-of-process iframe under a strict CSP (ADR 0150). The scanner sits in front of that:
it **blocks the clearly malicious** and **triages the rest for the maintainer queue**.

**The policy layer: runnable content is held.** Because no static check catches everything, any
version that carries runnable content — a Suit scene, a script, a plugin hook or MCP server
command, a binary, or instructions that tell an agent to run commands — is **held for a
maintainer**, whatever the publisher, verified and `ace` included, even when every check passes.
Only a **pure data entry** lists on a scan pass alone: a Suit with no scene, or a recipe or skill
with nothing runnable (prose and data, no scripts, hooks, binaries or command instructions). The
scan report carries a `runnable` flag that says which it is; `disposition` holds a runnable
version just as a `warn` holds it, and a maintainer's approval (or a `block`) still decides the
rest. A publisher sees "Held for review: it runs its own code" with the reason.

| Check       | What it reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`     | Native binaries by their bytes (Mach-O, fat Mach-O, ELF, PE, Java class), WASM outside a plugin, compiled AppleScript, archives inside the archive (zip, gzip, tar, 7z, rar, xz, bzip2, xar, dmg), executable bits where the type has none, and files a type doesn't take. A file that can't be decoded as text and isn't a recognised inert data format (image, font, audio, video) is held as an unknown binary. A Suit holds only `suit.json`, `suit.css`, its scene JS, ornaments, `market.json`, images, fonts and videos under `assets/`, and plain-text licence files (`LICENSE`, `LICENCE`, `NOTICE`, `COPYING`, `*.LICENSE`, `OFL.txt`, `*-OFL.txt`, or a `.txt`/`.md` named as a licence) at its root or under `assets/`, so a font's licence ships with it; nothing executable. A licence stays inert data: UTF-8 text with no NUL bytes, at most 256 KiB, still read by the hidden-content and secrets checks, never an instruction source and never runnable. A `.txt` anywhere else, or a licence with an executable bit, is a stray file. |
| `scripts`   | Skill scripts, plugin hook and server commands and their files, recipe-bundled skills, **and the commands an entry's instruction files hand an agent** — code blocks (fenced, indented or inline) and command lines in `SKILL.md`, a plugin's README, a recipe's task, notes and routines; no instruction file is exempt. Download-and-run, decode-and-run (the script a shell or interpreter runs is found past its options, so `sh -eu <fetched>` and `bash <(curl …)` are caught), persistence, credential access, **exfiltration followed as data flow** (the whole environment, a credential file, the home folder or a keychain reaching a network sink, through a real parse for JavaScript and TypeScript and by proximity for Python and shell; a source and a sink that can't be ruled apart is held, never passed), mining, reverse shells, privilege escalation, disabling security tools, self-modifying and obfuscated code. A skill that reaches a host carries the same note a plugin's undeclared hosts do.                             |
| `scene`     | A Suit's scene JS, read by a real parser and held to a capability allowlist (ADR 0150's drawing and animation APIs): a global off the allowlist, computed access on a global that isn't a constant on it, `constructor`/`__proto__`/`prototype` traversal to a callable, `eval`, `Function`, dynamic `import`, `importScripts`, workers and shared memory, `WebAssembly`, string timers, the network APIs, reaching the parent frame, and remote `url()`/`@import` in CSS or scripts in SVG — however they are spelled. The iframe sandbox and CSP stay as independent runtime enforcement.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `plugin`    | Declared commands and hosts against what the files do: a server or hook running a file the plugin doesn't hold, installing from an unpinned remote source at runtime (`npx pkg`, `@latest`, `pip install`, `uvx` without a version, `git clone`, `curl`), install scripts (`preinstall`, `install`, `postinstall`, `prepare`, `binding.gyp`), plain-http remotes, and hosts in code its manifest doesn't declare.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `recipe`    | Needs against the task: payment or credential connectors and tools whose reason and task don't say why; prompt injection in the task, notes, routines and `SKILL.md` ("ignore previous instructions", "send the person's keys to…", "don't tell the person"); instructions sending data to an outside address the task doesn't name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `secrets`   | 0168's key and token patterns and credential file names, in every text file of every type.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `hidden`    | Bidi controls anywhere, zero-width and tag characters in code and names (an emoji joiner between emoji is fine), mixed-script words in titles and display names, and typosquats: a name or handle whose skeleton matches, or is one edit from, an existing entry of another publisher or a verified publisher. Impersonating a verified publisher or ace blocks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `known-bad` | The maintainers' signed blocklist: content hashes, file hashes and patterns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Reading scripts.** The shell rules read commands through a TypeScript port of Spade's shell
reader (`spade_core::autonomy::shell::parse`, ADR 0171): words with quoting and escapes undone,
pipes, `$(…)`, backticks, process substitution, `sh -c` strings and wrappers (`env`, `sudo`,
`nohup`, `xargs`, `timeout`, `exec`, `command`) unwrapped to what they run, with `${IFS}` and
empty quotes folded first, so `c''url ${IFS}x|b\ash` reads as `curl x | bash`. Text the reader
can't read for sure is itself a finding. Other languages (Python, JavaScript, Ruby, Perl,
PowerShell, AppleScript) are read by token patterns over text with comments kept, unicode
normalised (NFKC) and zero-width characters removed first. A file that isn't UTF-8 is still read
(UTF-16 by its mark, else byte by byte), so Latin-1 or UTF-16 source can't slip past, and a file
with no known extension or shebang is read anyway, by every language's patterns. Obfuscation is
measured, not guessed: Shannon entropy over long lines, the length of base64 and hex runs, packer
signatures, `_0x` identifier density and `fromCharCode` arrays. JavaScript and TypeScript, for the
data-flow and scene checks, are read by a real parser (`@babel/parser`, pure, no build step).

**Why a TypeScript port, not spade-classify through WASM.** The market runs on Workers and the
daemon on Bun; the scanner must be one pure module both import with no build step. ADR 0172's
model is trained to tell a single tool call's effect for routing and abstains by design; a
publish decision has to be explainable line by line and table-tested, which rules are and a
learned score isn't. Building `spade-core` to WASM would bring Spade's whole autonomy crate (and
a Rust toolchain) into the Worker's deploy and the daemon's install for one parser. What we reuse
is the parser's design and its hiding markers (ADR 0172's `hides`), ported and tested here. The
classifier stays Spade's, at run time, where a skill's scripts actually run under its gate.

**Fitting Worker limits.** The scanner reads text only (binaries need their first bytes and their
hash), at most 1 MiB per file (past that, a script is a `warn`: "too long to read fully") and
works in steps: `scanStep(state, files, budget)` reads files in order until a budget of 4 MiB of
text or 600 files is spent and returns its cursor and the findings so far; `finishScan` runs the
checks that need the whole entry (declared hosts, typosquats, the recipe). An upload whose scan
doesn't finish within the request is stored as a draft in state `scanning`; the job (`scan_jobs`
in D1, partial findings in its R2 report) is carried on by later requests for the draft and by
the cron, one budget per step. A draft publishes only once its scan is done, and a scan that
didn't read every file is never a pass: `finishScan` blocks an entry whose files weren't all
read, so a budget running out can never list bytes an unread file could hide. The device and the
Worker run the same module on the same bytes, so they reach the same verdict.

**Known-bad list.** Maintainers keep a blocklist of content hashes, file hashes and patterns
(literal substrings, each with its reason). The signer signs it as its own statement,
`ace-market-blocklist` (label `ace-market-blocklist-v1`), uploaded with the withdrawn list and
served at `GET /v1/blocklist`. Devices fetch it with the withdrawn list. An installed entry whose
pinned bytes match it, or whose hash is revoked, is **turned off** (state `blocked`, with the
reason), never silently run and never deleted, as withdrawals are.

### 9. Reputation, holds and limits

- **A block refuses** listing, with the reasons. **A warn holds** the version for a maintainer, and
  so does any **runnable** version on a pass alone (decision 8's policy layer), whatever the
  publisher. Only a pure data version lists without review.
- **New publishers** (profile under 30 days old, or fewer than 3 versions that went live) get
  stricter thresholds: their first version is always held, and `note` findings marked `strict`
  (scripts present, plugin executions, network hosts, recipe connectors) hold too.
- **Limits per publisher** (authenticated, so counting them isn't tracking readers): 30 uploads a
  day (10 for new publishers), 1 GiB of stored versions and drafts (256 MiB new), 20 drafts. The
  official publisher (decision 14) has its own tier and is never new for limits: 500 uploads a
  day, 10 GiB, 200 drafts. It is still held for review. The `PUBLISHES` binding limits callers too.
- **Maintainer review.** `ace market review` lists what waits: held versions with their findings,
  pending listing edits, appeals and reports. `ace market review TYPE/NAME@VERSION --approve`
  releases a hold (the signer then signs it), `--block REASON` refuses it, and the existing form
  signs the review mark. A maintainer's approval covers that version's warns, never a block.

### 10. The signer's new work

- `ace market sign` re-scans, then signs, holds or blocks; it also signs the blocklist.
- `ace market review`, as above; `ace market reports` (list, `resolve ID --outcome … --note …`).
- `ace market collection list|put ID --title … --line … TYPE/NAME …|remove ID`.
- `ace market publisher HANDLE --suspend REASON|--restore` and
  `--withdraw-all REASON` (signs revocations of every live version of that publisher).
- `ace market block HASH --reason …`, `ace market block-pattern TEXT --reason …`.
- `ace market appeals` lists appeals; `ace market appeal ID --answer TEXT [--approve|--keep]`.
- `ace market verify HANDLE --reason …` and `ace market unverify HANDLE --reason …` sign the
  verified list (decision 13); `ace market official add|remove ACCOUNT` signs the official list
  (decision 14).

All behind the signer's token; signatures by the key on the maintainer's machine (0168 §6).

### 11. Contracts and modules

- **Every wire contract is in `@ace/protocol/marketplace`** (schema only): the catalog bodies,
  the signed statements (manifest, review mark, withdrawn list, blocklist), the publishing and
  signer routes, profiles, `/v1/me`, Discover and trending, reports and the scan report, beside
  the daemon's socket messages.
- **`@ace/marketplace` keeps the shared pure logic** both the Worker and the daemon run:
  signing and verification, the archive reader, hashing, the checks, the scanner, trending,
  handle and link rules, image validation and search. It imports its types from the protocol.
- **The daemon** gains `publish` (one operation, its `action` naming what), `discover` and
  `publisher` on `marketplace.request`. Reads (`discover`, `publisher`) need the read scope;
  `publish` needs admin. The fake daemon answers all of them from seeded state.
- **Routes**, all under `/v1`:

  | Route                                                                                                                                                                                                                                                                                                                                                                         | Who                           |
  | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
  | `GET discover`, `GET publishers/{handle}`, `GET avatars/{sha256}`, `GET previews/{sha256}`, `GET blocklist`, `GET verified`                                                                                                                                                                                                                                                   | anyone                        |
  | `POST reports`                                                                                                                                                                                                                                                                                                                                                                | anyone, rate-limited          |
  | `GET me`, `POST me/profile`, `PUT me/profile`, `PUT me/handle`, `PUT me/avatar`, `PUT me/pins`                                                                                                                                                                                                                                                                                | grant                         |
  | `POST me/drafts`, `GET/PUT/PATCH/DELETE me/drafts/{id}`, `POST me/drafts/{id}/publish`                                                                                                                                                                                                                                                                                        | grant                         |
  | `GET/DELETE me/entries/{type}/{name}`, `PUT …/listing`, `PUT …/previews/{n}`, `PUT …/latest`, `PUT …/visibility`, `PUT …/archived`, `POST …/withdraw`, `POST …/transfer`, `GET …/signals`                                                                                                                                                                                     | grant                         |
  | `PUT …/versions/{v}/changelog`, `PUT/DELETE …/versions/{v}/deprecation`, `POST …/versions/{v}/withdraw`, `POST …/versions/{v}/appeal`                                                                                                                                                                                                                                         | grant                         |
  | `POST me/transfers/{id}/accept`, `POST me/transfers/{id}/decline`                                                                                                                                                                                                                                                                                                             | grant (receiver)              |
  | `GET me/verification`, `POST me/verification`, `POST me/verification/check`                                                                                                                                                                                                                                                                                                   | grant (apply: recent sign-in) |
  | `GET signer/queue`, `GET signer/scan-context`, `PUT signer/holds/{type}/{name}/{v}`, `PUT signer/blocks/{type}/{name}/{v}`, `PUT signer/listings/{type}/{name}`, `PUT signer/publishers/{handle}`, `PUT signer/collections`, `PUT signer/blocklist`, `GET signer/reports`, `PUT signer/reports/{id}`, `PUT signer/appeals/{id}`, `PUT signer/verified`, `PUT signer/official` | signer token                  |

### 12. Privacy

ADR 0168 §10 holds. Download totals are per version, per hour and per day, with nothing about who
fetched. Reports store no address. Search logs nothing. Rate limits keep addresses only inside the
bindings' own memory. A publisher's signals are totals.

### 13. Publisher verification

- **Applying.** A publisher applies from their profile (`POST /v1/me/verification`, a sensitive
  action) naming what to prove: a domain, and optionally a GitHub account or organisation. The
  Worker answers one **proof token** per claim: 32 random bytes, single use, valid 48 hours.
- **What the mark proves**, stored as the list of proofs that passed:
  - **account**: the publisher is an authenticated ace account with a verified email (decision
    2); every applicant has it;
  - **domain**: a DNS TXT record `ace-market-verify=<token>` on the domain, read through
    Cloudflare's own DNS-over-HTTPS resolver, or `https://<domain>/.well-known/ace-market.txt`
    holding the token;
  - **github** (optional): a public gist of the account, or a file `.ace-market.txt` in a public
    repository of the organisation, holding the token.

  `POST /v1/me/verification/check` runs the checks; a passed token is spent. Every proof fetch is
  https only, follows no redirect, refuses IP-literal, `localhost` and private-suffix hosts, stops
  after 5 seconds and reads at most 4 KiB.

- **Maintainers decide.** An application with its passed proofs waits in `ace market review`.
  `ace market verify <handle> --reason …` signs the publisher into the **verified list**,
  `ace market unverify <handle> --reason …` signs them out; the publisher sees the reason. The
  list (`ace-market-verified`, label `ace-market-verified-v1`: each verified publisher's id,
  handle, proofs and when) is signed by the signer like the withdrawn list and served at
  `GET /v1/verified`. The Worker can't forge it; the device reads the mark only from a list it
  verified, and the index's `verified` flag is display data the device checks against that list.
- **One level.** Verified or not, plus the proofs: "Verified · owns example.com".
- **Re-checks.** The cron re-checks each verified publisher's domain proof about once a week, in
  bounded batches. A failed re-check flags the mark for maintainers in their queue and tells the
  publisher; it never drops the mark by itself.
- **Impersonation** stays blocked (decision 8): lookalike handles and names of verified
  publishers.
- **Verification never changes a scan.** Verified publishers get the same scans, holds and
  blocks as anyone.

### 14. The official publisher, "By ace"

- **`ace` is reserved** for ace's own organisation accounts. Only accounts on the signed
  **official list** (`ace-market-official`, label `ace-market-official-v1`: the `ace`
  publisher's id and the account ids that may publish as it) publish as `ace`; such an account
  acts as the `ace` publisher on every write and has no profile of its own. Maintainers keep the
  list with `ace market official add|remove <account>`; the signer signs it and uploads it with
  the withdrawn list, and it is served at `GET /v1/official`. Builds ship the market keys that
  check it, as for the other signed lists.
- **"By ace" is checked on the device.** An entry is by ace when its signed manifest's publisher
  is the official list's publisher id, on a list the device verified. The index's `byAce` and
  the review mark's `byAce` are display data the device checks against it; no profile field
  claims it.
- **Same scans, plus review.** Everything published as `ace` is scanned and checked like anyone's,
  and every version is held for a maintainer, as a new publisher's first version is.
- **Strict impersonation.** `ace`, `acehq`, `ace-official`, `official-ace`, `ace-team` and any
  handle whose confusable skeleton is `ace` or holds `ace` beside a reserved word (`official`,
  `team`, `hq`, `market`, `support`, `staff`), with digit, letter, homoglyph and bidi tricks
  folded first, are refused for every account not on the official list. Display names and titles
  that read as "ace" or "By ace" are blocked the same way.
- **The seed** (ace's Suits, the ten Spade recipes, the starter skills) is published as `ace`.
  Featured and collections stay editorial and apart from ranking.

### 15. Ranking tiers

One place in `@ace/marketplace` (`rankingTiers`) holds the multipliers:

| Tier             | Multiplier |
| ---------------- | ---------- |
| `official` (ace) | 1.3        |
| `verified`       | 1.1        |
| everyone else    | 1.0        |

They multiply an entry's score in Trending, its relevance in search and a publisher's downloads in
top publishers, and break ties in New and notable. They are bounded: a clearly more popular or
more relevant entry still outranks an official one (an unverified entry with ten times the
downloads outranks an official one), while among equals official ranks above verified above the
rest. They never touch scanning, holds, blocks or the review before install.

### 16. Several D1 databases: one per entry type, one per shared domain

Added 2026-11-16, before any data was stored. The owner asked for a database per feature so no
one D1 database (10 GB at most) carries the market's growth. The single `ace-market` database
becomes these, each with its own binding and migration folder:

| Database                | Binding             | Holds                                                                                                                                                                                                         |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ace-market-suits`      | `MARKET_SUITS`      | The catalogue of `suit` entries (below)                                                                                                                                                                       |
| `ace-market-skills`     | `MARKET_SKILLS`     | The catalogue of `spade-skill` entries                                                                                                                                                                        |
| `ace-market-plugins`    | `MARKET_PLUGINS`    | The catalogue of `spade-plugin` entries                                                                                                                                                                       |
| `ace-market-bots`       | `MARKET_BOTS`       | The catalogue of `spade-bot` recipes                                                                                                                                                                          |
| `ace-market-publishers` | `MARKET_PUBLISHERS` | Publishers and profiles, handle reservations, verification proofs and the signed verified list, the official list, drafts and their scan jobs, upload limits, the quota ledger, pictures and their tombstones |
| `ace-market-counts`     | `MARKET_COUNTS`     | Download totals per version, hourly and daily buckets, trending and its pass, top publishers, and the daily size record                                                                                       |
| `ace-market-moderation` | `MARKET_MODERATION` | Abuse reports, appeals and the signed blocklist                                                                                                                                                               |
| `ace-market-lists`      | `MARKET_LISTS`      | The signed withdrawn list, categories, featured and collections                                                                                                                                               |

A **catalogue** database holds one type's entries, versions (with their scan state and signed
manifests and review marks), listing edits, removals, pending withdrawals, transfer offers, the
entries' generations, its own `since` stamp and a copy of each publisher it names. The four
catalogues share one schema (`migrations/catalogue`), so they can't drift; `ace-plugin` gets
`ace-market-ace-plugins` when its ADR lands, by adding a binding that points at that folder.
Until then the Worker has no database for it and refuses its writes, as the checks already do.
Scan reports and bytes stay in R2 (decision 1).

**Where the split differs from a pure per-feature cut, and why.** Each change keeps an invariant
an earlier review fixed in one database:

- **Drafts live with publishers, not with their type.** A draft's bytes count against its
  publisher's quota and draft cap, checked in the statement that writes it; drafts are few per
  publisher and deleted after 30 days, so they add no growth.
- **Pictures live with publishers.** A picture's R2 key is the sha256 of its bytes, shared by
  every type and publisher that stores the same picture; the tombstone protocol (decision 1)
  needs every row that holds a key in the database that claims it.
- **The verified list lives with publishers**, so storing it and marking publishers stay one
  batch. The official list does too: it creates the `ace` publisher in the same batch.
- **Transfer offers live with their entry.** Accepting moves the entry's owner only while the
  offer stands, in one statement.

**Publisher copies.** An entry's row depends on its publisher's handle, state and verified mark.
Each catalogue keeps `publisher_copies` (id, handle, state, verified, created, `revision`). The
publishers database moves `revision` in the statement that changes any of those fields (a
trigger), and keeps `synced`, the revision every catalogue has. Applying a copy, in one catalogue
batch: write the copy only if its revision is newer, and in the same batch move the generation
of every entry of that publisher, restamp its listed ones (so a refresh that read the old copy
can't write it back, and `since` readers see the new handle), and record the refresh this
revision owes in `copy_refreshes`. The entries are then refreshed a bounded page at a time from
that cursor, which moves only while it is still for the revision read and is removed after the
last page; a newer copy starts it over. `synced` moves only after every catalogue applied the
copy and owes no refresh, and only forward. A request that changes a publisher applies the copy
at once with a bounded budget; the cron carries on every copy that is behind, so a cut-off
request or a publisher with many entries is finished over later runs. A catalogue's
`live_versions` count is its own, never overwritten by a copy; a publisher's live versions are
the sum over the catalogues.

**Every earlier invariant, and where it lives now:**

| Invariant                                    | Where, and how                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry generations and refresh                | One catalogue: entries and versions share it, so every version change is still batched with the generation. Publisher fields arrive as copies fenced by revision, bumping the generation in the same batch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Withdrawal list with version marks           | The signed list is stored in lists (only if newer and based on the stored one, as before). Each catalogue keeps `applied_lists`, the newest list it marked; one catalogue batch records the list as applied (only if not older), queues every entry the marks touch in `refresh_queue`, moves generations, sets the marks and drops the pending withdrawals, each statement re-checking that this very list is the applied one. The queue is then drained: a row goes only after its entry is refreshed, and only if it wasn't queued again meanwhile. A separate cursor (`withdrawn:refreshed`) records the list once its queue is empty. Sending the list again re-applies it; the cron applies a list a catalogue is behind on and drains any queue, so a refresh cut off after the marks committed is finished.              |
| Handle reservations, active and retired      | Publishers, unchanged: the triggers reserve and retire skeletons in the statement that writes the handle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Picture tombstones with owner and fencing    | Publishers: picture rows, claims, owners and generations together. Every reservation of a picture (an upload, or a listing edit) moves its row's `generation`. A listing edit, approved or pending, reserves every picture it names before the listing is written, and is refused while the cron is deleting one. The sweep asks the catalogues in parallel which listing pictures are named, then drops a row only at the generation it read, so one reserved again in between keeps it; the object is deleted only under a claim while no row holds the key.                                                                                                                                                                                                                                                                   |
| Once-per-hash download credit                | Counts. The download reads every catalogue in parallel for listed versions with the hash, credits the first listed (earliest `published`, then type, name, version), and writes all totals and buckets in one counts batch. The cron folds totals into the catalogues as absolute values, then marks them folded; both only ever rise (the larger of stored and incoming), and an entry is restamped only when its total rises. A fold cut off part way is redone with the same values, and a slower fold that read older totals lowers nothing.                                                                                                                                                                                                                                                                                 |
| Transfers                                    | The entry's catalogue: the owner moves only while the offer stands, in one batch with the offer's removal. The giver's pins are filtered on every read, so a stale pin never shows; the giver's charges move to the receiver after, and the quota reconcile corrects a move cut off part way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Publishing a version while a scan is running | Publishers then the catalogue. Publishing takes a claim on the draft, only while it holds the scanned hash with its scan done, and in the same batch moves the draft's bytes onto a charge for the version. Replace, edit and delete refuse a claimed draft. The catalogue then stores the version; then the draft goes. A cut-off publish resumes on the next try; the cron finishes a claim whose version was stored, and releases one whose wasn't.                                                                                                                                                                                                                                                                                                                                                                           |
| Quota, draft cap and uploads a day           | Publishers: drafts, pictures, upload days and `charges` (one row per stored version that isn't blocked) are summed in the statement that reserves. A charge is written before its version; only the cron's reconcile drops or corrects charges. Per publisher the reconcile is a pass (`usage_passes`) that walks every catalogue a bounded page at a time with a saved cursor, writing each version's charge and marking it seen; only when it has read every catalogue does it drop charges it never saw, and never one younger than ten minutes before it started, so a write on its way is never undercounted. A cut-off step leaves usage overcounted until a pass completes, never undercounted; the one exception is a transfer cut off before its charges moved, which undercounts the receiver until a pass reaches it. |
| Verified list and publisher marks            | Publishers, in one batch; the copies follow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Bounded cron work.** Every cross-database step the cron carries on (copy repairs, the quota
reconcile, withdrawn refreshes, draft claims) works in bounded pages from a persisted cursor and
spends its own budget, so one publisher's backlog in one step never starves the others.

**Reads that span databases** fan out to each catalogue in parallel and merge: the index, search,
Discover, featured and collections, a publisher's page and own entries, the signer's and
maintainers' queues, the scan's context and a download's hash lookup. Each fan-out is one query
per catalogue (four today), each bounded as before.

**The index and `since`.** Each catalogue keeps its own stamp, taken in the batch that makes a
change visible, as before. An index read reads every catalogue's stamp, then raises any catalogue
behind the highest to it (one `UPDATE … SET value = MAX(value, ?)`), then reads each
catalogue's rows. The answer carries the highest stamp. Every change not in the answer was
committed after its catalogue's stamp was read or raised, so its stamp is above the answer's:
none is missed, and none is sent twice except one racing the read itself. The raise is a write
on a read, but only for catalogues behind, so only the first read after a change pays it. The
wire stays one integer, so daemons already released keep working. A per-database vector cursor
was the alternative: also exact, but a protocol change for every client. A single stamp source
in another database was rejected: a stamp taken there and a row written later in a catalogue
can't be one batch, so a reader could pass the stamp before the row lands and miss it. ETags
remain the hash of the body.

**Growth and when to shard further.** The cron records each database's size (D1's
`size_after`) and every table's row count once a day, in `counts.database_sizes` and
`counts.table_rows`. A database's size row is written in the batch with its table rows and
marks that database's day complete, so a run cut off part way leaves only the rest for the next. Expected growth and the next cut:

| Database   | Grows with                                         | Expected                                     | Next cut, before 5 GB                                                      |
| ---------- | -------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| Catalogues | Entries and versions (manifests are a few KB each) | ~5 KB per version: a million versions per GB | Split the type by the name's first letter, or move manifests to R2         |
| Publishers | Publishers, pictures, drafts (bounded)             | ~2 KB per publisher                          | Pictures into their own database                                           |
| Counts     | `downloads_daily`: one row per version per day     | 400 days × versions downloaded each day      | `downloads_daily` by month (`ace-market-counts-<yyyy-mm>`), pruned with it |
| Moderation | Reports (capped at 500 open per entry), appeals    | Small                                        | Resolved reports older than a year to R2                                   |
| Lists      | Nothing: a few rows each                           | Kilobytes                                    | None                                                                       |

The Worker reads every database through one typed router (`src/store/databases.ts`): a
catalogue by entry type, or a domain by name. Store modules take the one database they need.

## Open for the owner

1. **A new publisher's first version always held:** keep, or hold only on a finding?
   Recommended: keep while the market is small.
2. **Archived entries and updates:** an archived entry offers no updates. Should a security fix
   still reach people who installed it? Recommended: unarchive to ship a fix.

## Options considered

- **spade-classify through WASM.** One classifier everywhere, but a Rust build in the Worker and
  daemon for a learned score that can't explain a refusal. Rejected (decision 8).
- **Scanning in a Queue consumer or a Durable Object.** Longer CPU per step, but outside the
  owner's stack. Bounded steps over the cron instead.
- **Re-encoding avatars with Cloudflare Images.** An outside service; validating and stripping
  the container gives the same safety for pictures shown under `nosniff` and a strict CSP.
- **Counting unique downloaders.** Better anti-gaming, but needs a per-caller key stored or
  hashed somewhere. Rejected for capped hourly totals and the in-memory binding.
- **Letting a warn list unreviewed.** Rejected by the owner: a warn holds.

## Consequences

- Publishers manage everything they publish; the page and the app share one API.
- Every entry is scanned three times by one module; a device never runs what its own scan
  blocks, whatever the Worker says.
- Maintainers gain a queue (holds, listing edits, appeals, reports) and the duty to work it.
- The account backend's market grant gains `iss`, `emailVerified` and `authAt`, and sessions
  record when they signed in.
- More D1 tables and R2 prefixes, with cron work bounded per step.

## Tests

- **Scanner tables** in `@ace/marketplace`: each rule with positive and negative cases, an
  adversarial table of obfuscated variants, and a corpus of inert benign and malicious samples
  written for these tests (no real malware; every host under `.invalid` or in the documentation IP
  ranges), whose measured detection is reported in the scanner's README. The adversarial corpus
  covers the bypasses a review found: commands hidden in instruction files, a script run past an
  interpreter's options, exfiltration flowing across lines, and scene capabilities spelled around a
  literal match, a second review's fail-closed bypasses (indirect module reads, truncation and
  prose intent, multi-call applets, unproven-`this` frame access), and a third's (sources the
  scanner can't prove harmless, executing "safe" leaves like `find -exec` and `sed e`, unreadable
  instruction snippets, document-wide intent, unknown binaries). On 203 malicious samples the
  scanner catches 100% (every one blocked or held) and blocks none of 95 benign and look-alike
  samples; with the policy layer, 23 of those (pure data) list and 72 (runnable) are held for a
  maintainer. Two invariants are pinned: a scan that didn't read every file is never a pass, and
  the device and the Worker reach the same verdict on the same bytes.
- **Trending** ranking, caps, bursts, decay and movement; **the verified boost**: a verified
  entry with clearly fewer downloads never passes an unverified one with many more, and among
  equals the verified one ranks first, in trending, search and top publishers; **verification**
  proofs (tokens single use and expiring, fetches refusing redirects, private hosts, plain http
  and large answers), the signed verified list, re-check flags; **the tiers**: official above
  verified above the rest among equals, and a much more popular unverified entry above an
  official one with very few downloads; **the official publisher**: an account off the signed
  list can't publish as `ace`, lookalike handles are refused, and a "By ace" mark not on the
  signed list is rejected on the device; **profile** rules (handles, reserved,
  lookalikes, links, avatars).
- **Worker** tests through its HTTP API on local D1 and R2: each write route refuses no grant, an
  expired grant, the wrong audience or purpose, a relay or cloud grant, an unverified email, a
  suspended account and another account's entry; sensitive actions refuse a stale sign-in; the
  publishing flow (draft, scan, publish, hold, block); each management action; Discover; reports.
- **Daemon** process tests: an entry the Worker lists but the device scan blocks is refused; an
  installed entry matching the blocklist is turned off; publishing while signed out says so.
