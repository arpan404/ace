# 0094: Next step per pull request, local checks and verified batch merge

Date: 2026-10-21. Status: accepted.

## Context

The Pull requests page lists what GitHub lists. The person still has to work out, per PR,
what is theirs to do, and the project's repository has no CI, so every PR reads "No checks"
and merging a batch means testing the combination by hand first. ace knows things GitHub
does not: which thread made a PR and whether that agent is waiting on the person, and it can
run the project's own check command on this machine.

## Decision

### Next step

`prNextStep` in `@ace/ui-core` is a pure rule from a list row, the viewer's login, the
linked thread's attention and the PR's latest local check to one step:

| Step      | When (first match wins)                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `answer`  | The linked thread needs the person.                                                                           |
| `review`  | The viewer is a requested reviewer and not the author.                                                        |
| `resolve` | Open, the viewer's or ace's PR, and it conflicts with its base.                                               |
| `fix`     | Open, the viewer's or ace's PR, and GitHub's checks or the local check failed.                                |
| `address` | Open, the viewer's or ace's PR, and changes were requested.                                                   |
| `update`  | Open, the viewer's or ace's PR, and its branch is behind its base.                                            |
| `merge`   | Open, not a draft, approved or no review required, no failing or running checks, not conflicting, not behind. |
| `wait`    | Otherwise for an open PR: checks running or a review pending from someone else.                               |
| `draft`   | A draft.                                                                                                      |
| `none`    | Closed or merged.                                                                                             |

"ace's PR" means a thread links it. The list groups open PRs by step: **Needs you** (answer,
review, resolve, fix, address, update), **Ready to merge** (merge), **Waiting** and **Drafts**.
Each actionable row shows its step as one text button. Answer opens the thread, Review opens
the PR's Code tab, Fix, Address and Resolve hand the PR to its thread's agent (or a new thread),
Update and Merge open the PR page where those writes already live; ready rows can also be
selected for a verified merge. List rows gain `behind` (GitHub's `mergeStateStatus` is
`BEHIND`) and `headSha`, read in the same GraphQL enrichment as the other row indicators.

### Verify: local checks and batch merge

The daemon's Verify service owns runs described in `packages/protocol/src/pr-verify.ts`.
A run is a `check` (one PR) or a `merge` (one to ten PRs on one base). The check command is
the project's `defaults.checkCommand`, else its `check` script with its package manager, else
none (`no_command`). Runs execute one at a time per project, in a temporary worktree under
the daemon's data directory that ace creates and removes; it is never a thread's worktree.
The project's worktree setup runs first, as for a new thread's worktree.

A merge run fetches the base and every head, refusing a head that no longer matches the
selected SHA. It merges each head in order into the base, stopping at the first conflict and
naming the PR before it. It runs setup and the check command once on the combined tree. If
that passes, it re-reads the base: if the base moved, it stops (`base_moved`) and merges
nothing. Otherwise it merges each PR on GitHub in order through the existing hosted merge
path, pinned to the tested head, with the person's merge method. It stops at the first
refusal, keeping what merged. A lost answer is `merge_uncertain`, which the PR page settles
through the hosted merge journal.

Runs, steps and logs persist in the daemon's store. Output is kept as a bounded tail (the
newest 2 MiB). A restart settles a run that had not reached GitHub as `interrupted` and kills
its process group through the process inventory; a run that was merging re-reads its PRs and
settles as `merged` or `stopped`. Every change pushes `verify.changed`. Starting and cancelling
need operate scope. Cancel is refused once GitHub merges began.

Stacked PRs (GitHub native stacks) are excluded from merge runs; their stack merge stays on
the PR page. Results stay on this machine: ace does not post commit statuses to GitHub.

### UI

A PR's latest local check appears beside GitHub's checks as "Local · <command>", with its log
in the existing check log view, and counts in the PR's checks gate and row mark. The list's
merge selection shows one strip above the rows: one sentence and text actions, for example
"Verify and merge 3 pull requests · Squash · Start", then "Checking #1219, #1221 and #1197
together on main · 2m 10s · Stop", then "Merged 3 pull requests" or "#1221 conflicts with
#1219 · Remove #1221". No icons on its buttons, no tinted strip.

## Consequences

- The person's own machine spends the CPU of every run; one run per project bounds it.
- A merge run merges on GitHub without a second confirmation once started; the strip's Start
  is that confirmation and names the PRs, the base and the method.
- Branch protection and required reviews still apply on GitHub; a refusal stops the run.
