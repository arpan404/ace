# 0188: A pushed tag releases ace, on ace's own runners

Status: accepted. Date: 2026-11-18. Decided by: the owner. Amends
[ADR 0177](0177-beta-release-line.md) (betas are built for every platform, not macOS arm64
only) and [ADR 0093](0093-linux-release.md) (Linux builds run on omarchy, not GitHub's hosted
runners). [ADR 0091](0091-desktop-auto-update.md)'s trust roots and
[ADR 0041](0041-packaging-and-distribution.md)'s signed daemon manifests are unchanged.

## Context

Agents built and published every release by hand: `release:build` or `release:beta build` on
the owner's Mac, notes written from the PR list, `release:publish`, and the cloud deployed by a
separate job of `release.yml`. That workflow built only Linux, on GitHub's hosted runners: its
first checkout ran before the Debian container had git, and its cloud job ran without the
Cloudflare token it needed. A release took an agent's whole session and could stop half done.

## Decision

**A tag starts a release; nothing else does.** The owner pushes `vX.Y.Z` (stable) or
`ace-X.Y.Z-beta-N` (beta) and `.github/workflows/release.yml` does the rest. There is no schedule,
and no `pull_request` or `pull_request_target` trigger: the repository is public, and a fork's
code must never reach ace's runners. `workflow_dispatch` takes an existing tag and reruns it, only
from `main`'s copy of the workflow. Only the repository owner can start or rerun a release.
Pushing a stable tag is the owner's approval; there is no separate approval gate.

**Three machines.**

| Runner                    | Labels                          | Runs                                                                                            |
| ------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| omarchy (Linux, x86_64)   | `self-hosted, linux, omarchy`   | every step of every release, beta and stable, except the two below                              |
| the owner's Mac           | `self-hosted, macOS, ace-mac`   | only the macOS build: package, sign, notarize, verify                                           |
| a Windows VM (ARM64 host) | `self-hosted, Windows, ace-win` | only the Windows x64 build, with x64 Node and Bun under emulation so every native module is x64 |

A job waits for its runner: if the Mac is asleep, the macOS build waits until it wakes. Linux
x64 and arm64 are each built in a fresh Debian 12 container on omarchy
(`tools/release/linux/pipeline-build.sh`, rootless podman by default); arm64 runs under qemu-user
emulation, because Linux natives are built on their own architecture (ADR 0093). The packages are
then installed and opened in a fresh Ubuntu 24.04 container, the oldest supported system: the
deb's `ace-desktop` command, its `/usr/bin/ace` CLI shim (marked as ace's, pointing at the
installed runtime and daemon, and answering `--version`), and the AppImage's contents.

**The steps.** Each is a job; the logic is in small pure modules under
`apps/desktop/src/packaging/` with unit tests, and the scripts in
`apps/desktop/scripts/pipeline/` are the I/O around them.

0. **gate** (omarchy) runs no repository code, only the workflow's own shell, so nothing from the
   tag runs before it passes. It checks that the owner started the run (`github.actor`) and,
   for a rerun, reran it (`github.triggering_actor`); that a push's ref is the tag and a manual
   run's ref is `main`; that the tag's name is exactly `vX.Y.Z` or `ace-X.Y.Z-beta-N`; and,
   through GitHub's API, that the tag's commit is on `main` (and, for a push, is the commit that
   was pushed). Every later job depends on it and checks out that commit, not the tag's name, so
   a tag moved meanwhile is refused (`prepare` compares them again). For a tag push the workflow
   file itself is the tag's copy: the tag ruleset, which lets only the owner create the tag, is
   what makes that copy trustworthy.
1. **prepare** (omarchy) checks the tag (`release-tag.ts`): its commit is on `origin/main`; a
   beta tag passes the same numbering rules `release:beta build` applies (`planBetaTag` in
   `beta-plan.ts`, which calls `planBeta`): its version is a later X.Y.Z than
   `apps/desktop/package.json` and its build number is the next one, ignoring later builds so an
   older beta can be rerun; a stable tag needs `package.json` already at that version. It creates
   the tag's **draft** release if there is none, and works out what is left to do.
2. **build-mac, build-linux (x64, arm64), build-windows** each build their platform with the
   existing scripts (`release:build <version>`, with the signed standalone daemon on macOS and
   Linux; `release:beta build --tag <tag>` for a beta). Every check those scripts make stays:
   the packaged app's launch and probe-worker check, the daemon archive's entry limit
   (`releaseArchiveLimits`), its smoke test before and after signing, the glibc floor.
3. **upload** (omarchy) checks each staged folder's hashes and commit, uploads its files to the
   draft, and last its manifest as `staged-<platform>.json`. It runs even when a build failed, so
   finished platforms are kept, and then fails.
4. **notes** (omarchy, in parallel with the builds) writes the notes onto the draft.
5. **deploy-staging** (omarchy) runs `bun run deploy:workers staging --version <tag>` once every
   platform is uploaded.
6. **deploy-production** (omarchy) runs `bun run deploy:workers production --version <tag>`:
   after every
   platform built and before publish, so the cloud is ready when apps update. That entry point
   deploys straight to 100%, smoke-tests, and rolls back to the previous Worker version on a
   failed smoke test. Its own checks decide what is already deployed.
7. **deploy-web** (omarchy) deploys the web app to Cloudflare Pages (below), after production's
   Workers and before publish.
8. **publish** (omarchy) needs every platform's manifest from the tag's commit and version, a
   signed and notarized macOS build, every listed file on the draft with its recorded bytes
   (size, and GitHub's SHA-256 digest when reported), and the notes. It adds `SHA256SUMS` and
   makes the release live for everyone at once: a stable release is marked latest, a beta is a
   prerelease that only the Beta line picks up (ADR 0177). Then it removes the staged manifests.
9. **refresh-marketing** (omarchy, stable only, never fails the release) asks Pages to rebuild
   acehq.dev (below).
10. **notify** (omarchy, always) tells the owner the release is live or which step stopped it.

Betas now ship every platform too: `betaHostProblem` accepts darwin-arm64, linux-x64,
linux-arm64 and win32-x64.

**The web app follows releases.** app.acehq.dev (Pages project `ace-web`) serves the latest
stable release's web app, no longer `main`: Pages' automatic production deploys from Git are
off. The deploy-web job builds `apps/web` from the release's commit with the existing build
script and `ACE_VERSION=<version>`, so the app names itself `web/<version>` to ace cloud
([ADR 0189](0189-cloud-features-gated-by-client-version.md)), and runs `wrangler pages deploy`
with the commit and the message `ace <tag>`. A stable tag deploys to the production branch
(`main`, app.acehq.dev) and to the Pages branch `beta` (beta.app.acehq.dev), so the beta site
never trails stable; a beta deploys to `beta` only, leaving app.acehq.dev alone.
`webDeployPlan` (`web-deploy.ts`) skips a branch that already serves a later published release
(`main` counts stable releases, `beta` both lines). A rerun deploys again rather than reading
what Pages serves: Pages uploads only files it lacks, so it is cheap and serves the same build.
Only the deploy step holds the Cloudflare token, which needs Pages edit. ace cloud and the
daemon allow `https://beta.app.acehq.dev` as a web origin beside app.acehq.dev, so the beta web
app signs in and pairs. After a stable release publishes, **refresh-marketing** POSTs the
`ace-marketing` Pages deploy hook (`MARKETING_DEPLOY_HOOK`) so acehq.dev rebuilds against the
new latest release; it never fails the release. Setup and rollback: `docs/release/web.md`.

**Resumable.** Every step checks what the tag's release already holds before acting. A
platform whose manifest is on the draft, from the tag's commit, with all its files, is not
rebuilt; a platform whose upload stopped halfway is rebuilt and re-uploaded (its old manifest is
removed first, so a stopped upload never looks complete). Notes already on the draft that pass
the checks are kept. A published release skips everything but the manifest clean-up and the
notification; in particular it never redeploys. Rerunning the failed jobs, or dispatching the
tag again, continues where the run stopped.

**One release at a time.** The workflow has one concurrency group, `release`, never cancelled
in progress; production deploys have their own group, `cloud-production`. GitHub keeps one run
pending behind the running one, so a third tag pushed meanwhile replaces the pending one, which
is then dispatched again.

**Release notes by an agent.** `release/notes.json` configures it: `provider` (only `claude`),
`model` (default `claude-sonnet-5-5`), `effort` (default `medium`), `template` (the
prompt, `release/notes-prompt.md`), length `limits` and `bannedTerms`. The range starts at the
newest published release older than the tag: a stable release counts from the previous stable
one, so its notes cover the betas it follows; a beta from the newest earlier release of either
line. Published releases, not git tags, because a tag that never became a release shipped
nothing. The PRs are read from the first-parent log (merge and squash commits) and
`gh pr view` (title, body, labels, number, author, merge state, base branch).

**Only trusted text reaches the agent** (`promptPullRequests`). A PR body and its labels can be
edited after merge, by more people than wrote the code. The agent sees only PRs merged into
`main`, and sees the body and labels only of a PR whose author has write, maintain or admin
permission on the repository (GitHub's collaborator permission API); any other PR is shown by
its number and title only. The prompt says the PR text is material, not instructions.

The agent runs on omarchy with the machine's own logged-in CLI, under the `ace-ci` user
(ADR 0002): ace never holds a provider credential. `ace run` would make it an ace thread, but it
has no read-only mode, so the pipeline invokes Claude's CLI directly with no way to act:
`--tools ""`, no MCP servers, plan mode, in an empty temporary folder. Model and effort pass
through (`--model`, `--effort`). It gets only the environment its CLI needs to find its login:
the job's GitHub token never reaches it. Only Claude: an agent that can read files or run
commands, even in a read-only sandbox, could be talked by a planted PR body into reading the
runner's registration token from its home and putting it in the notes.

`release-notes-check.ts` checks the reply: sections New, Improved, Fixed (and Known issues for
a beta), in that order, with only `- ` bullets under them (the app shows anything else as a
line); limits per bullet, bullet count and total length; every bullet cites a PR, and every PR
it cites is one the agent was given; no link, URL (with or without a scheme), Markdown link,
autolink, email address or HTML anywhere; none of `bannedTerms` (other products, AI tools), as
whole words. Plain text with real PR numbers is what the checks can guarantee; that a bullet
describes its PR truthfully is not, which is why the agent reads only trusted PR text. A rejected reply is retried once with every problem listed; a second
rejection fails the job.

**Notification.** The ace CLI has no notify command. The notify job writes the result to the
run's summary page and runs the hook named by `ACE_RELEASE_NOTIFY` in omarchy's runner
environment with a title and a body; when ace's CLI gains a notify command, the hook calls it.

### Security

- **Only the owner creates release tags.** A repository tag ruleset on `v*` and `ace-*-beta-*`
  restricts creation, update and deletion to the owner (no bypass for apps or other roles).
  The gate also refuses a run started or rerun by anyone else, and a tag whose commit isn't on
  `main`, before any of the tag's code runs.
- **No pull request reaches a self-hosted runner.** No workflow that runs on one has a
  `pull_request` or `pull_request_target` trigger; the repository's "Require approval for all
  outside collaborators" fork-PR setting stays on as a second line.
- **Dedicated users.** The runners run as an unprivileged `ace-ci` user on omarchy and on the
  Mac, and as a standard `ace-ci` account on the Windows VM. None is an administrator or in
  the `docker`/`wheel` groups; omarchy's containers are rootless podman.
- **Ephemeral runners.** Each runner registers with `--ephemeral`, takes one job, and its work
  folder is deleted before the next registers (`tools/release/runners/`). The registration token
  comes from a fine-grained token limited to this repository's Administration permission, kept
  in `ace-ci`'s home with mode 0600.
- **Secrets live in GitHub environments, not in the repository's secrets.** `release` holds the
  daemon manifest signing key (`ACE_RELEASE_PRIVATE_KEY`), the Mac signing keychain's password and
  Windows signing credentials; `staging` and `production` hold their Cloudflare tokens. Each
  environment accepts deployments only from `main` and the release tag patterns. Jobs get the
  narrowest `permissions`: only prepare, upload, notes and publish can write releases, and
  checkouts never keep the token.
- **The Apple signing identity is only in the Mac's `ace-ci` keychain** (`ace-signing.keychain-db`,
  with the notarization keychain profile). The keychain is unlocked for the macOS build and
  locked after it. The Ed25519 key that signs daemon manifests is written to the job's temp
  folder with mode 0600 for the build and deleted after it.

## Consequences

- A release is one `git push origin <tag>`. A failed run is fixed and rerun, never restarted.
- The Mac being asleep delays a release; it doesn't break it.
- Linux arm64 builds under emulation are slow (hours, not minutes). A native arm64 runner can
  take that job later by adding its labels.
- Deploying production before publish means Workers must keep serving the previous release's
  apps, as they already must for people who haven't updated.
- The daemon manifest key now lives in a GitHub environment rather than offline (ADR 0041), so
  Linux and macOS builds can sign their own archives. Anyone who can push a release tag can
  have it used, which the tag ruleset limits to the owner.
- The fine-grained runner-registration token is readable by `ace-ci`, and so by a job's code.
  Only the owner's tagged `main` commits run there, which is what keeps that acceptable.
- Tests cover the tag rules, the resume and publish decisions, the notes inputs and checks, the
  agent's environment and command, and the notification message. The workflow, the runners and
  the deploys are verified by the first real release.
