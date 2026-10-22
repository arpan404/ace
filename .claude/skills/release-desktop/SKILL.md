---
name: release-desktop
description: Build, sign and notarize the macOS desktop app on this Mac and put it in a GitHub release (draft first).
disable-model-invocation: true
argument-hint: "[publish]"
---

Release the desktop app from the owner's Mac to `arpan404/ace` on GitHub. The repo is public: a published release is visible to everyone at once, so every run ends on a **draft** unless the owner passed `publish` or says to publish in this conversation.

Secrets live in `~/.ace-release/`, outside the repo:

- `release.env`: `CSC_NAME`, `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `ACE_RELEASE_PUBLIC_KEY_FILE`.
- `ace-key.pem`: the Ed25519 release private key. Only its path is ever used.

Check variables by name and file existence only; secret values stay out of the transcript, commands and commits.

## 1. Preflight

Run from the main checkout (`~/Code/ace-next`). Every check passes before anything builds; on a failure, stop and tell the owner which check failed and how to fix it.

1. Branch is `main`, level with `origin/main` after `git fetch`, and `git status --short` shows no tracked changes.
2. `version` is the `version` in `apps/desktop/package.json`. `gh release view v<version> -R arpan404/ace` fails (the tag is free). If it exists, stop: bumping the version is the owner's call, done in a PR. Any PR you create for the version bump or preflight fixes stays unlinked from the ace thread (never `thread_link_pr`): linking settles the thread and closes the terminals the build needs.
3. `~/.ace-release/release.env` loads (`set -a; source ~/.ace-release/release.env; set +a`), every variable above is non-empty with no `XXXX`/`xxxx` placeholder, and the `.p8` and public key files exist.
4. `security find-identity -v -p codesigning` lists `Developer ID Application: $CSC_NAME`.
5. `xcrun notarytool history --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"` exits 0.
6. `uname -m` is `arm64`. The build targets the host only, so this release is Apple silicon only.
7. Node 24.13.0 for the build: download `node-v24.13.0-darwin-arm64.tar.gz` from nodejs.org into a new temp directory and check it against the `darwin-arm64` hash in `tools/release/src/node-runtime.ts`. The daemon archives refuse any other Node.

## 2. Build

```sh
bun install --frozen-lockfile --os=darwin --cpu='*'
set -a; source ~/.ace-release/release.env; set +a
export ACE_RELEASE_PRIVATE_KEY_FILE=~/.ace-release/ace-key.pem
PATH=<node 24.13.0>/bin:$PATH bun run release:doctor
PATH=<node 24.13.0>/bin:$PATH bun run release:build <version> --with-daemon
```

The `--os`/`--cpu` flags also install the Intel builds of optional native packages such as sharp, which the `darwin-x64` daemon archive stages; a plain install has only the host's and the build fails with `Missing image runtime dependency`. `release:doctor` lists every check; stop on any ✗. `release:build` packages, signs and notarizes the app, verifies it (`codesign`, `spctl`, `stapler`), launches it with an empty data home and fails unless its daemon starts and the updater begins a check, builds and signs the daemon manifests for both macOS architectures, and stages everything with checksums under `dist/releases/v<version>`. It passes the version to the packager itself, so an `ACE_VERSION` inherited from a running ace does not leak in.

It takes 10–20 minutes (notarization is most of it); run it in the background and wait for it to exit. Done when it exits 0 and `dist/releases/v<version>/` holds `ace-<version>-arm64.dmg`, `ace-<version>-arm64-mac.zip`, their blockmaps, `latest-mac.yml`, `darwin-arm64.json`/`.sig`, `darwin-x64.json`/`.sig` and both daemon archives.

## 3. Notes

Write `dist/releases/v<version>/notes.md`. Users read these notes in the app's update prompt, and the app shows less than GitHub does (`apps/desktop/src/main/os/release-notes.ts`):

- Only the **first 8 lines** of the note appear; the rest show as "and N more".
- Each line is **cut at 220 characters**.
- Headings are hidden, and bold and links become plain text, so a line must make sense without its section heading.

Earlier notes broke all three rules: the install line took the first slot, every feature line was cut off mid-sentence, and the fixes never showed. Other mistakes from earlier notes: internal words such as "settling", "frost", "strip", "daemon" and "fencing"; unrelated changes joined into one line; and fixes for features that were new in the same release.

### Collect the changes

1. **Range.** `base` is the latest _published_ release, read before your draft exists: `gh release list -R arpan404/ace --exclude-drafts --exclude-pre-releases -L 1 --json tagName -q '.[0].tagName'`. Don't use the previous git tag: a tag that never became a published release (v0.0.3, for example) shipped nothing to users. `head` is `commit` in `dist/releases/v<version>/release.json`, the commit that was built. `main` may have moved since the build.
2. **Pull requests.** PRs land as merge commits or as squash commits, so read the first-parent history, not just `--merges`:
   ```sh
   git log --first-parent --format='%h %s' <base>..<head> \
     | sed -nE 's/^[0-9a-f]+ (Merge pull request #([0-9]+).*|.*\(#([0-9]+)\))$/\2\3/p'
   git log --first-parent --format='%h %s' <base>..<head> | grep -vE 'Merge pull request #[0-9]+|\(#[0-9]+\)$'
   ```
   The first command lists PR numbers. The second lists commits pushed straight to `main`; include those too.
3. **What each PR changed.** Run `gh pr view <n> -R arpan404/ace --json title,body,files` for every PR. A merge commit's subject is only the branch name, and a title can overstate or leave out what a PR does, so read the body. When the body is unclear, read the PR's commits (`git log --format='%s' <merge>^1..<merge>^2`) and the diff.
4. **Check names against the app.** Grep `apps/web/src` for every button, page and setting you name, and use the label exactly as the app shows it.

### Decide what goes in

Leave out:

- Version bumps, release tooling, CI, tests, ADRs and docs, refactors, lint and format changes, and dev-only changes.
- iOS-only changes. The iPhone app ships on its own.
- Fixes for something added in this same release. Users never saw the bug, so describe the finished feature instead.
- Anything replaced or reverted within the range. Describe only how it works at `head`.
- Anything already in the previous release's notes (`gh release view <base> -R arpan404/ace --json body -q .body`).

When a PR changes several unrelated things, give each user-visible change its own line, or drop the minor ones.

### Write

```markdown
## New

- **Pull requests show what to do next.** Each open PR has one button: Review, Fix checks, Resolve conflicts or Merge.

## Improved

- ...

## Fixed

- ...

## Install

macOS, Apple silicon. Download `ace-<version>-arm64.dmg`, open it and drag ace to Applications.
```

- **Order by importance across the whole note.** The first 8 lines are all most users see. Lead with the most important new feature. Keep the total to about 6–12 lines. A small release can be 3 lines.
- **One line per change, under 200 characters.** Start with a short bold phrase that says what the user gets, then one plain sentence with the detail. No sub-bullets and no paragraphs between bullets.
- **Write for someone who uses ace but has never seen the code.** Say what they can do now or what looks different, and where to find it in the app. Don't use internal names (daemon, socket, settle, lease, worktree internals, service or module names) or commit-message wording.
- **Fixed lines say what used to go wrong**, in the user's terms: "Images no longer get stuck on _Image unavailable_," not "Retry image chunks across reconnects."
- **Install goes last.** It only matters to new users downloading from the release page. Put a step users must take once (such as installing by hand from an old version) at the top, as one line, only when it applies.
- Don't add text the parser counts as a line, such as a summary paragraph, a "Full Changelog" link at the top, or `---`.

### Check

Preview what the app will show, from the main checkout (it needs the installed packages):

```sh
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { releaseNoteItems } from './apps/desktop/src/main/os/release-notes.ts';
const r = releaseNoteItems(readFileSync(process.argv[1], 'utf8'));
r.items.forEach((line, i) => console.log(i + 1 + '. ' + line));
console.log('shown ' + r.items.length + ' of ' + r.total);
" dist/releases/v<version>/notes.md
```

Done when no shown line ends in `…`, the 8 shown lines are the 8 most important changes, and every line comes from a PR in the range and matches what the app does at `head`. Show the owner the notes and the preview together with the draft.

## 4. Draft release

```sh
bun run release:publish <version> --draft --notes-file dist/releases/v<version>/notes.md
```

It refuses files that changed since the build or a commit GitHub doesn't have, and uploads to a draft tagged at the built commit. Done when `gh release view v<version> -R arpan404/ace` shows `draft: true` with every staged file.

## 5. Publish

Only with `publish` in the arguments or the owner's go-ahead in this conversation: `gh release edit v<version> -R arpan404/ace --draft=false --latest`. Done when `gh release view` shows it published and `gh api repos/arpan404/ace/releases/latest -q .tag_name` is `v<version>`.

## Report

The release URL, draft or published, the asset names and sizes, the verification results from the build, the PR range the notes cover (`<base>..<head>`, with the number of PRs included and left out), and the in-app preview of the notes.

## Known limits

- Intel and Linux desktop builds need matching machines; this skill ships the Apple silicon app only.
- Apps from 0.0.2 and earlier can't update in place; they show "is available" with Download, which opens the release page.
