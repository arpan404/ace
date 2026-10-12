# Pull request workspace integration

This layout started stacked on #499, `feat/forge-pr-issue-browser`, and now targets
main. It uses the existing daemon reads and guarded commands. Companion features
that have landed on main are reused directly; pending features retain adapter slots.

After #499 and #521 landed, main was merged into the redesign. The existing hosted
review provider is keyed by PR identity around the workspace. Summary retains
review submission, owned-comment editing/deletion, and thread resolve/reply controls;
the floating comment control uses the durable conversation form. Code reuses those
hosted draft and viewed commands through the shared renderer. Native line writes and
viewed marks apply only to the full PR range; historical extensions still receive
the exact displayed identity. Review reconciliation remains available while stale
detail blocks ordinary writes. Supplied extension adapters take precedence over
native diff/composer controls.

`apps/web/src/features/forge/index.ts` exports `PrScreen`, `PrDetail`,
`PrWorkspaceExtensions`, `PrListExtensions`, `PrWorkspaceContext`, `PrDiffContext`, and
`PrWorkspaceExtensionProvider`. Pass adapters to `PrScreen` so all its resource tabs
receive them. `PrDetail` also accepts them directly. Each callback receives the
workspace identity, fresh detail, a `disabled` fence, and an awaited `refresh()`.

| Companion PR                  | Adapter slots                                                                       | Integration                                                                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #516 auto-merge and queue     | `headerActions`, `overflow`                                                         | Use its `forge.pr.merge-state` capabilities and reconciled command controls. Replace the existing auto-merge entry when installing the richer control.                                                             |
| #520 issues                   | `reference`                                                                         | Resolve bare `#N` to an ace issue or PR view. Same-repository PR URLs already open resource tabs; unresolved bare references fall back to GitHub.                                                                  |
| #521 reviews and viewed files | `review`, `viewed`, `viewedCount`, `onLineComment`, `annotation`                    | Supply the review submission flow, version-bound viewed state and shared diff line annotations. `review` receives the draft body and may open that PR's review-kind selector before dispatch.                      |
| #527 metadata and lifecycle   | `reviewers`, `labels`, `editDescription`, `comment`, `closeWithComment`, `overflow` | Use its lifecycle capability read and write journal. Editors own their dialogs. The composer confirms close with a second click. Return a rejected promise for failed or uncertain writes so it retains the draft. |
| #528 worktrees and tasks      | `headerActions`, `overflow`, `resolveInWorktree`, list `actions`                    | Open `PrTaskActions` or the existing new-task flow with the current verified PR selection. The conflict adapter opens that flow; it must not create a worktree or execute setup on click alone.                    |
| #529 stacked PRs              | `summary`, list `beforeRows`, list `actions`                                        | Render stack navigation alongside the description or above list rows, and use normal PR tab navigation for a selected stack member.                                                                                |

Only supply a callback when its daemon capability exists. Omitted adapters hide the
editor, Review mode, composer, close action, Viewed checkbox/count, line-comment
button or worktree conflict action. The base branch exposes no standalone comment
or review command, so its composer is hidden. Add-reviewer remains available through
the existing guarded request-review command when a linked task permits it.

Adapters must combine `context.disabled` with their own capability freshness,
pending and uncertain-write fences. They own receipts, reconciliation and head
checks, and must not retry uncertain mutations. `refresh()` must succeed before
clearing a write fence. Header/overflow/property/list render callbacks own their
accessible controls and confirmations. The existing #499 commands remain in the
overflow popover with their reconciliation state mounted across dismissals.

Diff adapters (`viewed`, `viewedCount`, `onLineComment`, `annotation`) receive
`PrDiffContext`. Its `files: ForgePrFiles` is the exact displayed response, including
`ref`, `baseSha`, `headSha`, and optional `commit`. For a historical commit,
`files.baseSha` is its first parent and `files.headSha` is that commit, while
`detail.status.headSha` still identifies the full PR. Use `files` for annotations,
line writes and viewed-version keys. A historical viewed count covers the displayed
page. The diff's disabled fence also includes a fetching or failed file read. An
adapter that cannot safely handle a historical range must hide or disable its
writes when `files.commit` is present.

The shared workspace owns PR chips, the new-tab launcher, full view and persisted
side/bottom docking. Dock controls are enabled only for this workspace. PR identity
includes project, host, owner, repository and number. The list stays mounted while
the detail opens, preserving filter inputs, paging and scroll position.
On phones, More actions → Pull request workspace reopens its active resource or
the PR launcher. The thread workspace retains its own Changes entry.

## Additive read fields

All new protocol fields are optional for older daemon resources:

- `ForgePrDetail`: `updatedAt`, `createdAt`, `additions`, `deletions`,
  `authorAvatarUrl`, `reviewerAvatars`.
- `ForgePrRow`: `authorAvatarUrl`, `commentCount`, `reviewCount`, `ci`.
- `ForgeCommit`: `authorAvatarUrl`, `additions`, `deletions`.
- `ForgeComment`: `authorAvatarUrl`.
- `ForgeActivity`: `actorAvatarUrl`, `subject`, `commitSha`; the existing schema now
  also exports its inferred type.

REST supplies metadata, avatars and timeline event details. One bounded GraphQL
request adds list indicators to the existing count request; one batch per commit
page supplies statistics. Commit reads revalidate the head after enrichment.
Unknown provider fields stay in raw data, including the search/indicator and
commit/statistics source pairs. Unknown timeline kinds remain visible. File pages
remain bounded to 25 with the existing 3,000-file cap; timeline history is bounded
to 3,000 events and commits to 250. Shared diff and timeline renderers virtualize
long content. Relative times use ace's shared minute clock and pure formatter.

Provider contracts: [REST pull requests](https://docs.github.com/en/rest/pulls/pulls),
[GraphQL pull requests](https://docs.github.com/en/graphql/reference/pulls),
[GraphQL commits](https://docs.github.com/en/graphql/reference/commits), and
[issue event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types).

## Reference comparison

| Supplied reference      | Workspace result                                                                                                                                              | Capability-dependent differences                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1: Header and Summary   | Four header rows, external link, conflict chooser, checkout copy, branch/stats line, segmented tabs, sparse properties and Markdown description.              | Pencil and property editors require #527; the existing reviewer command is retained when available.                         |
| 2: Summary and composer | Collapsible description/checks/comments, empty-comment copy, floating popover with Comment/Review modes and confirmed Close with comment.                     | Composer controls appear only with #521/#527 adapters, so the #499-only preview omits them.                                 |
| 3: Timeline             | Shared header, comment/commit counts, newest/oldest toggle, vertical rail, interleaved comments/events/commits, SHA/time and commit statistics.               | Provider-bounded histories show an explicit limit notice.                                                                   |
| 4: Code                 | Commit picker, file count, whitespace/unified/split/wrap/collapse/tree controls, collapsible status/path/stats headers and syntax-highlighted numbered diffs. | Viewed/count requires #521. Provider file pages retain previous/next controls and explicit missing/truncated-patch notices. |

Summary, Timeline and Code were inspected in one temporary fake-daemon web preview,
then the server was stopped. The preview used sample read data and did not dispatch
GitHub writes. A workspace-kind readiness issue exposed by hot navigation was fixed
after those captures. This is a structural comparison, not a pixel-difference test.
Behavior tests were written for metadata, indicators, timeline ordering and unknown
events, commit-head races, composer submission/confirmation/freshness, Markdown
navigation, docking persistence and workspace-kind loading. Tests were not run.

Round-1 review tightens the layout to the #538/#539 scale: a `text-ui` medium title,
`text-xs` metadata, 8px header gaps, compact section spacing and `text-ui` description
prose. Additional unrun regressions cover phone reopening/launching, historical
annotation and line-draft identity, viewed-version isolation, and colliding numeric
IDs across comment/review/event kinds. The latest #499 branch is merged, preserving
its review-extension behavior and diff-content versions.
