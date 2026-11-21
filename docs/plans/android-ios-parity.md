# Android full iOS parity plan

Prepared 2026-10-26. Reference commit: `b92d9d2618481dfd8c77a94c6bcab5a26fa61395`.
Tracking issue: [#561](https://github.com/arpan404/ace/issues/561).
Status: execution started. See the [progress ledger](android-ios-parity-progress.md)
for dispatched tasks, reviewed results and outstanding gates.

## Outcome and baseline

Deliver an installable, production Android client with every user-visible capability of the
iOS app at the reference commit, using Android-native presentation and the same daemon
authorization, canonical state and durable-command behavior. The original seven-item MVP is
an intermediate milestone, not the finish line. Include the newer Forge, project, file,
administration, live-media and transfer features.

Android currently has the Expo/Hermes/Compose foundation, shared tokens and SDK, a fixture
inbox/thread, text composer, approval card, bounded Agents sheet and SQLite outbox. Its
Machines sheet is a fixture display. App startup always calls the debug-only fixture runtime;
there is no production pairing path. Reuse this work, but reverify it against the current SDK.

[#565](https://github.com/arpan404/ace/pull/565), the Phase 0 spike, merged on October 12.
Its body and the [measurement report](../verification/android-phase0/README.md) still contain
unmerged-draft wording. Accepted emulator evidence does not close its performance gates:
input p95 passed, scrolling remains unresolved, memory did not plateau, and replay did not
exercise a daemon restart. [#562](https://github.com/arpan404/ace/pull/562) supplied shared
tokens; [#588](https://github.com/arpan404/ace/pull/588) supplied a visualization fallback.

The [iOS README](../../apps/ios/README.md), source and behavior contracts define the feature
inventory. Older roadmaps, screenshots and iOS checkpoints are supporting evidence, not the
complete current specification. Some describe capabilities as deferred that current source
implements. Known iOS defects are regression cases to avoid reproducing.

At final sign-off, compare with then-current main and record every iOS addition since the
reference commit. Full parity cannot be declared with an unassigned difference. Neither
platform's deferred remote push proposal becomes a release requirement merely through this plan.

## Execution rules

- Parent role: orchestrator. Define task packets, sequence dependencies, review changes,
  arrange checks and integrate. Delegate implementation and independent review.
- Implementation provider: `opencode`; model: `opencode-go/muse-spark-1.3-contributor`;
  effort: `xhigh`; account: `opencode-cli-default`. The model catalog lists this effort.
  Login/quota still need verification on first dispatch. Do not silently substitute a model.
- Dispatch one task ID per child, not a whole milestone. Give it a unique role, stable request
  ID, explicit owned files, acceptance scenario, allowed commands and stop conditions.
- A task is one observable result. Aim for one reviewable diff in one owning module, normally
  no more than six implementation files. If inspection finds another behavior, a package API
  redesign or unrelated repairs are needed, return findings and split the task before editing.
  Do not cut a cohesive module arbitrarily to meet a file count.
- Start with one implementation child and one bounded read-only review child. Independent
  implementation children may run together only with disjoint file ownership and resolved
  contracts. Shared package exports, app routing, dependency files and native registration have
  one owner at a time. Parent does not dispatch competing edits to those files.
- No child redelegates, starts providers for fixture generation, commits, pushes, publishes,
  merges, creates infrastructure or changes dependencies outside its assigned scope.
- Existing public package APIs own correctness. Android calls them directly in Hermes. Extract
  reusable logic into its existing package only when necessary, with its own bounded task;
  do not import iOS bridge internals or implement another state/replay/status engine.
- Use feature folders and pure logic behind thin native adapters. Proposed ownership folders
  below are planning boundaries, not permission to invent duplicate abstractions.
- Honor the shared-machine limits: one Gradle build with at most four workers; one driving job
  per shared device. Coordinate active Ace threads before device use. Use `Ace_Android` and
  `Ace_Tablet`; never create temporary AVDs or erase another app's data. Reuse the registered
  iOS devices only for reference checks. No parallel simulator cloning.
- Run focused behavior checks for each implementation, then the repository completion gates
  at integration. `AGENTS.md` requires `bun run check`; the older Android README discourages
  root checks on the shared Mac. Resolve where the full check runs during A00.03, rather than
  skipping it or launching an unbounded run. Report unavailable checks as incomplete.
- Keep secrets and private conversations out of logs and committed evidence. Use fixture
  data; real-host mutation and input checks get an explicit, narrow test target.
- Preserve the user's Git identity and attribution preferences. Do not add assistant credits.

## Task packet and completion record

Each dispatch contains:

1. Task ID and a one-sentence observable result, dependency IDs, reference iOS behavior.
2. Exact allowed paths and public contracts. Existing files outside that scope are read-only.
3. One success scenario and the relevant failure, reconnect, read-only or stale-result scenario.
4. A bounded command list, resource limit and device reservation, if needed.
5. Explicit exclusions, including no secondary cleanup, dependency upgrades or backend redesign.
6. Required return: changed paths, behavior, checks with results, evidence location, remaining
   concerns. Stop when the task passes or return the precise blocker without widening scope.

Task states: planned, ready, running, review, verified, blocked. No task below is verified by
being listed. Integration records the reviewed commit and evidence beside its ID. A screen
that only renders fixture data is not a completed production feature.

Every milestone has a gate; its leaf tasks are the dispatch units. Dependencies below are
milestone dependencies. Within a milestone, dispatch in listed order unless the public
contracts are already fixed and the files are disjoint. Extra dependencies are called out.

## Milestone map

| Milestone | Deliverable                                          | Depends on    | Task IDs      |
| --------- | ---------------------------------------------------- | ------------- | ------------- |
| M00       | Frozen parity inventory and repeatable validation    | None          | A00.01–A00.06 |
| M01       | Close prototype performance and replay gaps          | M00           | A01.01–A01.06 |
| M02       | Secure production pairing and app lock               | M01           | A02.01–A02.08 |
| M03       | Multi-machine runtime and lifecycle                  | M02           | A03.01–A03.06 |
| M04       | Production inbox and navigation                      | M03           | A04.01–A04.07 |
| M05       | Complete transcript and bounded history              | M04           | A05.01–A05.08 |
| M06       | Composer, tuning and all interaction cards           | M05           | A06.01–A06.11 |
| M07       | New conversations and project workflows              | M04, M06      | A07.01–A07.07 |
| M08       | File browsing, editing and authenticated links       | M07           | A08.01–A08.06 |
| M09       | Agents, Changes and machine transfers                | M05, M06, M07 | A09.01–A09.09 |
| M10       | Full Pull requests, Issues and GitHub inbox          | M04, M07, M08 | A10.01–A10.14 |
| M11       | Machine settings, accounts and catalogs              | M03, M04, M07 | A11.01–A11.11 |
| M12       | Thread tools, terminal and published content         | M05, M06, M11 | A12.01–A12.06 |
| M13       | Live browser, devices and computer use               | M03, M04, M12 | A13.01–A13.11 |
| M14       | Notifications and ongoing thread status              | M03, M04, M06 | A14.01–A14.05 |
| M15       | Accessibility, adaptive UI and release certification | M00–M14       | A15.01–A15.09 |

M00 and M01 establish the foundation before advancing the paired-device MVP, as required by
[ADR 0073](../adr/0073-native-mobile-clients.md). If physical measurement is unavailable, keep
the gate open and record the blocker. Do not replace missing evidence with emulator claims.
Later independent milestones can overlap after their dependencies pass. For example, Forge,
administration and notifications need not wait for live-media implementation.

## M00: establish the reference and validation lane

| ID     | Bounded task and ownership                                                                                                  | Acceptance                                                                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A00.01 | Audit iOS routes, menus and actions into a capability matrix under `docs/mobile/`; read source and contracts, no app edits. | Every reachable iOS action has its reference path, Android task ID, grant requirement and evidence status. Include Pulls, current navigation, transfers and no-project chats.                |
| A00.02 | Define Android navigation and platform equivalents in that matrix; own only the navigation specification.                   | Every capability is reachable on phone/tablet; resolve the old no-tab mockup versus current iOS Pulls navigation explicitly. Apple-only behavior has an Android equivalent and limits.       |
| A00.03 | Audit and document bounded Android build/test commands and CI ownership; no app or harness edits.                           | Debug and release-like builds, focused TS/native/UI tests and the full repository completion gate have assigned locations, commands and resource budgets.                                    |
| A00.04 | Correct stale Android status wording and connect the matrix to #561; documentation only.                                    | Merged PRs are described accurately, prototype limits and unmet gates remain explicit. No issue is closed merely by updating documentation.                                                  |
| A00.05 | Add the missing Android fixture-driven UI/native behavior harness identified by A00.03.                                     | One real app scenario exercises launch, interaction and canonical result; the runner has a selected shared device, bounded timeout and deterministic cleanup.                                |
| A00.06 | Wire the focused Android validation lane into CI.                                                                           | A deliberately broken fixture behavior fails the lane; Android dependency boundaries/typechecks and the repository completion gate have explicit owners. Native build work stays serialized. |

Gate: the matrix covers current source, the validation lane is reproducible, and the first
implementation packet has an exact file list. Do not create dozens of GitHub issues until
the inventory has been reviewed for omissions and duplicate ownership.

## M01: prove the foundation can support the full app

Ownership: existing Android runtime/storage/input instrumentation, fixture scripts and
`docs/verification/android-phase0/`. Keep build tooling changes separate from measurements.

| ID     | Bounded task                                                                               | Acceptance                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A01.01 | Add a release-like/profileable performance variant with explicit fixture opt-in.           | Production Release excludes fixture transports, probe routes and input-injection hooks; the measurement variant runs reproducibly.                                 |
| A01.02 | Measure and diagnose transcript presentation pacing under the recorded streaming workload. | Preserve raw frame-timeline evidence; explain current/legacy jank and high-input-latency counts. Any discovered fix gets a separate task before rerunning.         |
| A01.03 | Establish warmed memory behavior under bounded history and a longer soak.                  | Record native/JS/graphics allocation breakdowns and an explicit plateau/growth budget. A rising trace or unexplained retained history fails the gate.              |
| A01.04 | Extend replay verification through a daemon restart and lost receipt.                      | Persist a send, prove admission, lose receipt, restart app/daemon and reconnect; exactly one canonical admission and eventual local cleanup. No database reset.    |
| A01.05 | Restore production tail limits while retaining separate stress fixtures.                   | Normal startup retains the shared SDK's bounded tail; paging and live streaming still work. The 2,200-item spike cap cannot leak into production configuration.    |
| A01.06 | Run a physical Android baseline and compare with the emulator evidence.                    | Input p95 is at most 100 ms with at least 95% capture coverage; scrolling and memory pass documented device budgets. Record hardware and thermal/build conditions. |

Gate: input, visible pacing, memory and both restart cases have passing, attributable evidence.
The existing 47.8 ms emulator input result is a baseline, not a new measurement.

## M02: connect securely to a real daemon

Ownership: proposed `apps/android/src/pairing/`, `src/security/` and the local native module.
Transport, credential storage and biometric checks are separate packets with narrow adapters.
Reference ADRs 0070, 0073 and [0097](../adr/0097-tailscale-https-certificates.md).

| ID     | Bounded task                                                                   | Acceptance                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A02.01 | Specify the native HTTPS/WSS adapter contract against existing SDK interfaces. | Typed cancellation, response/frame bounds and trust inputs are fixed without another reconnect engine. Public SDK gaps are reported as separate work.                                     |
| A02.02 | Implement native HTTPS trust evaluation and bounded requests.                  | Correct SPKI pin and certificate validity pass; wrong pin, redirects and invalid validity fail before credentials leave. Apply only the current explicit ts.net trust exception.          |
| A02.03 | Implement native authenticated WSS transport using the same trust policy.      | Binary/text frames and close/error/cancel flow work through the SDK; no fallback to an unpinned RN socket after failure.                                                                  |
| A02.04 | Implement Keystore-backed credential persistence and removal.                  | Tokens survive a permitted restart, stay outside SQLite/logs/drafts, and cannot be read under another host/device key; backup/restore and invalidation behavior are tested.               |
| A02.05 | Implement paste-link confirmation and redemption.                              | Strip fragments before networking, show host/grants/fingerprint, redeem once, handle expiry and bind the authenticated host identity.                                                     |
| A02.06 | Add QR capture as input to the same pairing flow.                              | Camera grant/denial, cancel and malformed QR work without a second redemption path or logging the code.                                                                                   |
| A02.07 | Implement biometric/device-credential app lock and remembered timeout.         | Locked launch/background return exposes no conversation or ordinary runtime access; cancellation and unavailable biometrics have a deliberate recovery path.                              |
| A02.08 | Wire production startup and fresh-ticket exchange.                             | Release reaches the paired daemon over Tailscale; every connection gets a fresh single-use ticket. Empty/removed/revoked pairings route correctly and fixture startup remains debug-only. |

Gate: real-daemon pairing works on a physical phone; wrong identity never receives credentials.
Observe current daemon trust policy rather than copying obsolete iOS README passages.

## M03: own each machine and survive Android lifecycle events

Ownership: proposed `src/machines/`, `src/runtime/` and existing SQLite adapter.

| ID     | Bounded task                                                            | Acceptance                                                                                                                                    |
| ------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A03.01 | Persist the shared machine directory and host/device database bindings. | Duplicate pairing, host mismatch, app restart and database migration preserve identity and isolate outboxes.                                  |
| A03.02 | Own one SDK runtime per paired machine.                                 | Two machines connect concurrently; one failure does not close the other; replaced runtime callbacks cannot update the new owner.              |
| A03.03 | Implement rename/remove/retry and real Machines details.                | Readiness, grants, version and last seen are real; removal awaits shutdown before deleting only that credential/database.                     |
| A03.04 | Feed foreground/background and network changes to SDK wake/reconnect.   | Resume, network switch and stale socket recover; lifecycle listeners do not accumulate and reconnect does not duplicate commands.             |
| A03.05 | Enforce per-machine capability/grant guards at action admission.        | View-only, Projects and Accounts grants are checked independently; denied UI actions send no mutation and daemon refusals remain visible.     |
| A03.06 | Bound pending reads and cancel stale route/runtime requests.            | Late service replies after navigation/removal are ignored; reconnect refreshes active reads; request caps and timeout cleanup are observable. |

Gate: two real or isolated fixture machines remain independent through disconnect, removal,
process death and reconnect. A saved Done row reads Syncing until canonically confirmed.

## M04: production inbox and navigation

Ownership: `Inbox.tsx`, app routing and proposed `src/inbox/`; one routing owner at a time.

| ID     | Bounded task                                                                      | Acceptance                                                                                                                                              |
| ------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A04.01 | Merge machine inboxes using shared grouping/ranking and scoped row keys.          | Same thread IDs on two hosts remain distinct; Needs you, Working, Syncing, Unsent, Done and Snoozed match shared rules.                                 |
| A04.02 | Add current iOS-equivalent row content, filtering, sorting and search.            | Project/provider/account/machine marks and unread/attention words stay correct as a row changes; incremental updates avoid full-history work.           |
| A04.03 | Add settle/archive, Undo, unarchive, snooze and wake actions.                     | Durable commands target the correct machine; expired snooze regroups while its machine is offline; failed actions retain a retryable state.             |
| A04.04 | Add the bounded archived-thread browser.                                          | Page, open and unarchive archived rows without replacing another machine's active subscription; read-only grants remain read-only.                      |
| A04.05 | Implement the reviewed phone navigation, back behavior and thread route identity. | Inbox, Pulls and Browse destinations are reachable; predictive back closes the right layer; stale actions cannot target the newly opened thread.        |
| A04.06 | Add conversation-content search and historical-hit routing.                       | A hit opens its machine/thread at the matched history window without replacing the live tail; canceled searches cannot overwrite newer results.         |
| A04.07 | Add hardware-keyboard New thread, Search and Next/Previous thread commands.       | The same four iOS commands work with Android platform modifiers, current list order, text-entry focus and read-only guards; no stale selection is used. |

Gate: inbox actions and navigation work across two machines, offline states and cold starts.
Tablet master/detail comes in M15, without a second data owner.

## M05: readable, bounded conversations

Ownership: split existing `Thread.tsx` into cohesive modules under `src/transcript/`.
Use shared transcript/work-log/step/history APIs rather than copying iOS bridge presentation.

| ID     | Bounded task                                                                | Acceptance                                                                                                                                    |
| ------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A05.01 | Render shared answer/user/event block membership incrementally.             | A delta updates its row; turn endings, refusals, repeated errors and handoff/fork dividers appear with canonical wording.                     |
| A05.02 | Render native Markdown text, code and tables.                               | Streaming then completed content keeps selection/identity; code has language/Copy; long text is bounded and malformed content stays readable. |
| A05.03 | Add grouped live work, reasoning and background-command disclosures.        | Collapsing hides the same tools/narration as iOS; a completed root with live descendants never reads Done.                                    |
| A05.04 | Add paged completed-turn steps and detail reads.                            | Opening, reopening and releasing a long turn obey shared cache limits; reads do not rebuild the live transcript.                              |
| A05.05 | Implement bounded older/newer history windows.                              | Read at least 25 pages backward and return forward while live streaming continues; retained item/window counts stay bounded.                  |
| A05.06 | Preserve reading anchors and tail-following state.                          | Paging and in-place disclosure keep the tapped/read row stable; Jump to latest resumes following; repeated sends do not jump or crash.        |
| A05.07 | Add authenticated full-message/thought reads and message menus.             | Truncated text expands within shared size limits; Copy/Share/time and link routing use the exact item and host.                               |
| A05.08 | Keep a bounded set of recent thread views and reconcile reopened snapshots. | Rapid parent/child/back navigation keeps readable content; removed rows disappear and stale callbacks cannot corrupt a reopened view.         |

Gate: long-history, high-delta and repeated-send scenarios pass with presentation and memory
budgets. These are behavior tests, not snapshots of implementation shapes.

## M06: compose and answer with full fidelity

Ownership: proposed `src/composer/`, `src/interactions/` and `src/models/`.

| ID     | Bounded task                                                      | Acceptance                                                                                                                               |
| ------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A06.01 | Implement shared Send/Steer/Queue and fenced Stop behavior.       | Waiting-on-subagents, busy root and pending question produce the right control; Stop targets the run seen, never a later visit/run.      |
| A06.02 | Add queue inspection, edit, remove, move and steer-now.           | Canonical queue updates reconcile offline/reconnect and uncertain receipts without duplicating a message.                                |
| A06.03 | Implement model/account picker and favorites.                     | Provider capabilities, account defaults, unavailable models and switching failures match iOS; choices affect the intended thread only.   |
| A06.04 | Add effort, speed and access controls.                            | Shared capability/default/nearest-stricter rules drive choices; unsupported values cannot be submitted.                                  |
| A06.05 | Add local attachment staging and bounded uploads.                 | Photos/files, remove/retry, files-only send, relaunch and upload refusal work without whole-file JS/base64 buffering.                    |
| A06.06 | Add mentions, composer commands and persisted draft recovery.     | Draft edits survive failed/delayed persistence; route/project changes cannot leak draft attachments or mentions to another context.      |
| A06.07 | Complete approval handling beyond the spike.                      | Large option sets keep exact IDs; read-only/stale/already-answered approvals send no invalid resolution; retry does not double-answer.   |
| A06.08 | Implement questions, multi-select and free-text/composer replies. | Shared validation, dismiss and first-answer-wins behavior match the pending canonical question.                                          |
| A06.09 | Implement plan review and MCP form cards.                         | Review/revise and typed form fields preserve drafts on refusal; stale interaction IDs and invalid required fields are rejected.          |
| A06.10 | Implement browser request cards.                                  | Responses are capability-gated and tied to the displayed request; changed or completed requests cannot be answered by a stale card.      |
| A06.11 | Add goal pause/resume/clear controls.                             | Shared provider capabilities and canonical goal state determine actions; a late response cannot change the goal on another thread visit. |

Gate: every iOS interaction type has an Android scenario, including offline persistence,
read-only grants, duplicate taps and route changes.

## M07: start work and manage projects

Ownership: proposed `src/new-thread/` and `src/projects/`.

| ID     | Bounded task                                                        | Acceptance                                                                                                                                      |
| ------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A07.01 | Add project selection, recent projects and no-project chats.        | Correct machine/project is selected; explicit Projects grant and no-project creation rules match iOS.                                           |
| A07.02 | Add agent/account/model/effort/speed/access choices for a new task. | Use shared payload/default rules; missing CLI, signed-out account and unsupported access show actionable reasons.                               |
| A07.03 | Make new-thread draft and creation durable.                         | Relaunch/retry reuses its command ID; files-only creation works; uncertain receipt never creates a second thread.                               |
| A07.04 | Add first-message files and project-scoped mentions.                | Draft-owned files restore after relaunch and clean up only after ownership transfers or explicit removal.                                       |
| A07.05 | Add existing-folder discovery and Add project.                      | Registered-root boundaries and read-only grants are honored; a refused operation explains how to add on the host.                               |
| A07.06 | Add New project and Clone repository with persisted forms.          | Retry/cancel/progress follow existing daemon operations; process death cannot create duplicate projects/clones.                                 |
| A07.07 | Add past CLI-session discovery/import entry points.                 | Source machine and provider identity stay attached; unavailable history/import states are handled without starting a provider as a side effect. |

Gate: a newly created task opens on its owning machine after canonical admission, including
offline start and relaunch. Provider tasks used for final real-host checks are separately scoped.

## M08: files and local links

Ownership: proposed `src/files/`, built on the SDK's authenticated services.

| ID     | Bounded task                                                          | Acceptance                                                                                                                                   |
| ------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A08.01 | Add thread/project file tree and quick open.                          | Bounded listing, shared ordering, change letters and read-only project browsing match iOS.                                                   |
| A08.02 | Add text/code/Markdown/image viewing and large/binary export.         | Shared read/highlight limits and line-number navigation work; oversized content is offered through a bounded download/share path.            |
| A08.03 | Add version-checked text editing and save conflict handling.          | Newer host content is not overwritten without explicit Replace; failed save preserves local edits.                                           |
| A08.04 | Add create, rename and move operations.                               | Shared path/refusal rules apply; UI reconciles canonical paths and refuses unauthorized mutations.                                           |
| A08.05 | Add delete, Undo and Recently deleted restore.                        | Only the selected host/path changes; duplicate taps, reconnect and conflicts preserve recoverability.                                        |
| A08.06 | Route message file links and authenticated external-to-project files. | Checkout links open at their line; host files outside the project use the item-scoped download API, never arbitrary device/host file access. |

Gate: file mutations are checked against fixture/temp roots, never arbitrary real user files.

## M09: agents, source control and transfers

Ownership: proposed `src/agents/`, `src/changes/`, `src/transfers/`.

| ID     | Bounded task                                                        | Acceptance                                                                                                                                  |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A09.01 | Complete tree/usage/background-task Agents presentation.            | Shared depth-first whole-tree status matches iOS; agent and task changes subscribe independently.                                           |
| A09.02 | Add child-thread/lane navigation and per-agent stop.                | Actions name the viewed agent/run; returning preserves the parent; late lane results are discarded.                                         |
| A09.03 | Add Changes file summaries and bounded diffs.                       | Live status refresh and file opening match shared change rules; oversized diffs are explicit.                                               |
| A09.04 | Add commit editor and optional generated commit-message draft.      | Message is reviewable before commit, attribution follows user preferences and stale changes/refusals preserve the draft.                    |
| A09.05 | Add push and create/open PR from Changes.                           | Existing daemon operations enforce remote/head checks; uncertain outcomes reconcile before retry. Forge page implementation belongs to M10. |
| A09.06 | Add merge/readiness entry points from Changes.                      | Current head/gates are displayed and confirmed; no bypass of merge restrictions or duplicate merge submission.                              |
| A09.07 | Add Continue on and Open on destination/options sheets.             | Shared placement/refusal rules, parent path, changes/ignored-file choices and grants match iOS.                                             |
| A09.08 | Add transfer progress, cancel/retry/dismiss and reconnect recovery. | One shared transfer store drives sheet/thread lines; unknown outcome is reconciled and newer state invalidates stale controls.              |
| A09.09 | Add transfer completion routing to the destination thread/project.  | Correct host and resource open after completion; source/destination identities and canonical completion survive app restart.                |

Gate: task trees remain accurate through source-control and transfer work; a transfer is not
reported complete while remote work remains active or waiting on a person.

## M10: full Forge parity

Ownership: proposed `src/forge/`. Use daemon-hosted `gh` and shared `@ace/ui-core` rules;
the Android app never asks for GitHub/provider credentials. Each editor/write path gets its
own admission and uncertain-result behavior.

| ID     | Bounded task                                                     | Acceptance                                                                                                                              |
| ------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A10.01 | Add PR lists, project selection, filters, search and pagination. | Counts, involvement, drafts/reviews/checks and sorting match shared rules; canceled/older responses cannot replace newer queries.       |
| A10.02 | Add Issue lists and issue detail reads.                          | State/labels/author filters, body and linked threads match the selected machine/repository.                                             |
| A10.03 | Add PR detail, readiness, checks and merge gates.                | Primary action and blocked reasons come from shared rules and the exact head shown.                                                     |
| A10.04 | Add native rich Forge text and task boxes.                       | Allowlisted HTML/Markdown, alerts, tables, details, mentions/references and task edits preserve source versions.                        |
| A10.05 | Add authenticated Forge media and bounded offline snippets.      | Private images/video load through the daemon; SVG/WebM/Mermaid equivalents have no arbitrary network/native bridge access.              |
| A10.06 | Add timeline and comment/reply/edit/delete editors.              | Permissions, locked conversations, expected-text conflicts, @/# completion and unconfirmed-result reconciliation match iOS.             |
| A10.07 | Add Files changed, per-file diff and inline conversations.       | Bounded paging and exact line/head identity remain correct after refresh; inaccessible files are explicit.                              |
| A10.08 | Add pending reviews and submit/approve/request-changes.          | Review rules, draft comments, duplicate submissions and uncertain outcomes use existing canonical operations.                           |
| A10.09 | Add reviewer management.                                         | Current reviewer choices, permissions and expected versions drive add/remove requests; uncertain outcomes reconcile before retry.       |
| A10.10 | Add PR lifecycle management.                                     | Draft/ready and other exposed lifecycle actions use exact displayed versions, permissions and reconciliation.                           |
| A10.11 | Add merge and auto-merge controls.                               | Confirm the displayed head, honor all gates and use the linked thread or project route as appropriate.                                  |
| A10.12 | Add New PR.                                                      | The reviewed project/base/head and body are submitted through existing daemon actions; uncertain creation is reconciled before a retry. |
| A10.13 | Add issue edit/close/reopen and start-thread linking.            | Versioned issue operations affect only the selected issue; issue-started threads retain the issue link and durable creation ID.         |
| A10.14 | Add GitHub notification inbox and cross-repository routing.      | Read-state operations reconcile; a notification opens the correct in-app issue/PR, including another repository.                        |

Gate: every action in the current iOS Forge inventory is mapped and tested, not just list/detail
screens. No broad "finish Forge" assignment is allowed.

## M11: administration and configuration

Ownership: proposed `src/settings/`, `src/accounts/`, `src/catalog/`.

| ID     | Bounded task                                                        | Acceptance                                                                                                                                                                             |
| ------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A11.01 | Add machine preferences and source-control/remote-access readiness. | Selected-machine reads refresh on reconnect; writes use daemon grants/version rules without exposing host secrets.                                                                     |
| A11.02 | Add usage, quotas and account readiness.                            | Shared usage words, windows and provider/account grouping match iOS; missing data is distinct from zero usage.                                                                         |
| A11.03 | Add installed CLI account/sign-in continuation.                     | Choices, verification codes/URLs and Enter prompts relay host-supervised CLI login; ordinary service sockets never carry API keys.                                                     |
| A11.04 | Audit iOS API-key capability and the dedicated provider-auth path.  | Matrix states exactly what iOS exposes; if exposed, create a separate encrypted-channel implementation packet. Never submit a key through generic requests or persist it on the phone. |
| A11.05 | Add automation list/run/enable controls.                            | Action targets the right machine/automation; missed reads refresh and permission refusals remain visible.                                                                              |
| A11.06 | Add automation editing.                                             | Trigger configuration, schedule anchors and concurrent-edit revisions survive round trips; an uncertain save is reconciled.                                                            |
| A11.07 | Add prompt-file browsing and revision-checked editing.              | Newer host text is not silently replaced and dirty drafts survive failed writes.                                                                                                       |
| A11.08 | Add CLI skill/command discovery and availability.                   | Source/provider scope and available versus unavailable entries match iOS; discovery does not invoke a coding task.                                                                     |
| A11.09 | Add plugin catalog/install flow.                                    | Current iOS install choices and trust confirmations are preserved; canonical installation state reconciles after reconnect.                                                            |
| A11.10 | Add plugin review and source editing.                               | Versioned review/source changes preserve newer host content; refused edits retain the draft and never change another plugin.                                                           |
| A11.11 | Add plugin availability/scope controls.                             | The same installed plugin can report different availability per scope; shared rules and daemon grants determine permitted changes.                                                     |

Gate: feature availability follows explicit paired-device grants, not a blanket administrator
assumption. Login checks do not spend provider quota without an assigned test.

## M12: thread tools and published artifacts

Ownership: proposed `src/tools/`, `src/terminal/`, `src/published/`.

| ID     | Bounded task                                             | Acceptance                                                                                                                                                               |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A12.01 | Add per-thread skills/commands and MCP tools.            | Shared capability/readiness rules control discovery and actions; reconnect refreshes scoped content.                                                                     |
| A12.02 | Add durable forks/branches and handoff entry points.     | New branches retain canonical linkage and retry IDs; fork/handoff dividers and routing agree with source/target threads.                                                 |
| A12.03 | Implement terminal stream ownership, credit and resume.  | Acknowledged byte offsets bound buffering; reconnect resumes or marks a gap; stale output cannot reach another terminal.                                                 |
| A12.04 | Implement the native terminal renderer and keyboard bar. | Match iOS's supported VT controls and bounded scrollback; soft/hardware keyboard, resize and output gaps are usable. Do not promise unsupported full terminal emulation. |
| A12.05 | Add authenticated published images and sandboxed HTML.   | Full visualization replaces the prototype fallback; shared HTML restrictions hold, network/native bridge escapes are refused.                                            |
| A12.06 | Add task profiles and thread-tool navigation.            | Local instructions are included explicitly in the intended first message; profile edits and tool routes do not leak across machine/thread changes.                       |

Gate: terminal/artifact resources close on exit; streams, downloads and renderers have explicit
memory and cancellation bounds.

## M13: live browser, remote devices and computer use

Ownership: proposed `src/browser/`, `src/devices/`, `src/screen/` and native decode/views.
Read the current shared media protocol before writing adapters. Keep large frame buffers out
of JS state and avoid base64 image loops. Viewing never implies authority to control.

| ID     | Bounded task                                                               | Acceptance                                                                                                                                            |
| ------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A13.01 | Implement native shared-media frame parsing, decoding and delivery credit. | JPEG/H.264, stream reset, compressed/binary pieces and malformed input obey bounds; acknowledge actual native consumption.                            |
| A13.02 | Add live browser session/tab selection and navigation chrome.              | Correct session/URL/tab loads and refreshes; close/switch/reconnect release only that subscription.                                                   |
| A13.03 | Add browser controller leases and touch/IME/keyboard input.                | Tap/drag/pinch and international input work; view-only and lost leases refuse input; input is never replayed after reconnect.                         |
| A13.04 | Add browser tools/console and remaining exposed controls.                  | A00.01's current iOS controls all have an equivalent; stale console/session results cannot update the next tab.                                       |
| A13.05 | Add remote device inventory/details and boot/app/URL/appearance actions.   | Device identities and capability errors come from the daemon; no confusion between Android SDK and Xcode readiness.                                   |
| A13.06 | Add device live view, active-display selection and orientation.            | Correct H.264 display, dimensions and insets render; secondary/foldable panels are selectable without nesting a simulator window frame.               |
| A13.07 | Add device controller gestures/keyboard and exposed input actions.         | Leases, read-only limits, cancel and disconnect work; input is not replayed to a later session.                                                       |
| A13.08 | Add device recording.                                                      | Start/stop/cancel and download use canonical recording state with bounded output ownership; disconnect never invents completion.                      |
| A13.09 | Add computer-use preferences and app/session discovery.                    | Host enable switch, OS permission reasons and blocked-app settings match iOS, scoped to the selected machine.                                         |
| A13.10 | Add computer live viewing and control handover.                            | H.264/JPEG, foreground/background mode, take/release/return control and input use the separate authenticated screen channel.                          |
| A13.11 | Add computer recording and verify stream isolation.                        | Browser, device and screen frames never cross sessions; navigation/disconnect stops recording or exposes the existing daemon-owned result accurately. |

Gate: certify decode latency, frame pacing, bandwidth adaptation, memory and thermal behavior
on physical Android hardware while retaining person-first leases. Audit browser audio/relay
against actual iOS capability; implement exposed functionality, do not infer it from an open
umbrella issue. No phone pretends it is a host emulator controller outside daemon authority.

## M14: notifications and the Android equivalent of local Live Activities

Ownership: proposed `src/notifications/` and narrow native notification adapters.
Reference [ADR 0087](../adr/0087-ios-local-notifications.md) and
[ADR 0089](../adr/0089-ios-native-tools-and-local-activities.md).

| ID     | Bounded task                                                   | Acceptance                                                                                                                                                                                                       |
| ------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A14.01 | Add live canonical alerts and per-host catch-up ledger.        | Host/id namespacing, cursor reset, duplicate suppression, retractions and relaunch match the canonical feed. Never derive alerts from cached thread status.                                                      |
| A14.02 | Add notification permission/settings and per-machine mute.     | Ask in context; denied permission has recovery; mute/unmute sends register/unregister correctly through reconnect and never revives muted alerts.                                                                |
| A14.03 | Add authenticated notification actions and cold-start routing. | Allow/Deny revalidate the exact pending interaction and grants; stale/offline state cannot answer blindly; taps unlock and open the intended host/thread.                                                        |
| A14.04 | Define and implement Android best-effort background catch-up.  | A bounded platform-supported worker records its actual delivery limits; Doze, battery restriction and process death cannot create a false always-on promise. Adapter choice is documented before implementation. |
| A14.05 | Define and implement an ongoing thread-status surface.         | User-started canonical status has stale/offline rules and tap routing equivalent to local Live Activities; cached Done cannot end it. Android foreground-service/permission implications are resolved first.     |

Gate: delivery guarantees are truthful on physical devices. FCM/remote push is a separate ADR
and hosted-service decision, as on iOS; it is not silently introduced to satisfy local parity.
Do not promise widgets/share targets absent from the frozen iOS capability matrix.

## M15: make it a complete Android product and certify parity

Ownership: proposed `src/appearance/`, adaptive layout components, release/CI configuration
and `docs/verification/android-ios-parity/`. Fixes discovered during certification become
separate bounded tasks, never an omnibus polish assignment.

| ID     | Bounded task                                                  | Acceptance                                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A15.01 | Add persistent appearance and keyboard preferences.           | System/light/dark, supported palettes/accent, fixed semantic colors and Return-to-send match iOS capabilities with bundled fonts and no OEM dynamic-color override.                                                       |
| A15.02 | Add tablet/foldable master-detail and resizing.               | Same runtime owners serve compact and expanded layouts; rotation, split-screen, fold/unfold and keyboard preserve route/draft/reading position.                                                                           |
| A15.03 | Run TalkBack, large-text, contrast, motion and input audits.  | Every route/action is labeled/reachable, focus returns correctly, touch targets and keyboard insets pass; fix findings in separately owned packets.                                                                       |
| A15.04 | Add app identity, launch state and licenses.                  | Production icon/splash/version and licenses are correct; startup/loading/error/empty states are complete.                                                                                                                 |
| A15.05 | Add diagnostics export.                                       | Export contains actionable version/counter/failure evidence without credentials, pins, private conversation text or unnecessary machine identifiers.                                                                      |
| A15.06 | Add production packaging, signing hooks and release CI gates. | Reproducible release artifact, migration/upgrade install and fixture exclusion are checked. Signing secrets use user-controlled provisioning; release never depends on Metro.                                             |
| A15.07 | Run the complete parity matrix and reference-delta audit.     | Each iOS capability has Android evidence, reviewed failure cases and a passing or explicitly blocked status. New iOS changes have assigned tasks before parity sign-off.                                                  |
| A15.08 | Run physical OEM/release-like certification.                  | Pixel, Samsung, Xiaomi and OnePlus runtime checks cover typography, IME, lifecycle, notifications, media and performance; unavailable hardware remains an open release gate.                                              |
| A15.09 | Prepare release handoff and distribution checks.              | Clean-install, upgrade, revoked pairing, recovery and documented known limits pass; full repository checks and Android checks pass. Store/internal distribution and owner-held signing are reviewable before publication. |

Gate: no missing capabilities, hidden fixture-only screens, unproven required measurements
or failed required checks. Signing/store access may block distribution; it does not justify
marking an incomplete app as feature-complete. Publishing is a separate final action.

## Cross-cutting checks for every feature

| Concern           | Required behavior                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical state   | Root completion cannot hide working children, background commands or unanswered interactions. Reconnect invalidates stale completion.                                                         |
| Durable mutation  | Local persistence precedes draft clearing; command IDs survive uncertain results; replay produces one admission. Use the service's reconciliation contract where it is not an outbox command. |
| Authorization     | Exact machine/device/thread/resource, explicit grants and current capability are checked at admission. UI hiding alone is insufficient.                                                       |
| Request lifetime  | Route and runtime generations reject late results; reads have cancellation/bounds; reopening does not duplicate subscriptions.                                                                |
| Large data        | Bounded lists/history/diffs/text/media, incremental subscriptions, no full-history work for a delta, no whole-file/base64 buffering.                                                          |
| Android lifecycle | Process death, background/foreground, network changes, rotation and keyboard interruption preserve committed state. Do not assume persistent background sockets.                              |
| Platform parity   | Match the user's capability and outcome; choose native Android interactions. Record platform limits rather than imitating unavailable Apple frameworks.                                       |
| Validation        | Fixture success plus relevant refusal/stale/reconnect cases, inspected native UI evidence and physical-device evidence where required. Static checks alone do not certify a feature.          |

## Integration and first dispatch queue

Use small review-ready PRs, normally one leaf task or a tightly coupled pair, linked to #561
and their IDs. Never put all Android parity into one integration PR. Every PR states the
behavior, evidence, incomplete checks and remaining gate. Independent review is another
bounded OpenCode task with the same requested model/effort and a read-only scope.

The first queue, after this plan is presented:

1. A00.01: source-based capability inventory, read-only app access, one matrix artifact.
2. A00.02: navigation/equivalence specification using that inventory.
3. A00.03: bounded validation-lane audit, then A00.05 harness and A00.06 CI work as separate packets.
4. A00.04: correct stale status docs after reviewing the inventory.
5. A01.01: isolate a release-like measurement variant; then A01.02–A01.06 in the device lane.

Before each dispatch, replace broad proposed folder ownership with exact paths. If a table row
still contains multiple independent adapters/editors, divide it into suffixed IDs such as
`A10.11a` and `A10.11b` with their own acceptance cases. Only those smaller packets are sent.
Milestone tables define coverage; packets define executable scope. This keeps the parent an
orchestrator and makes progress reviewable without giving a child an open-ended mandate.
