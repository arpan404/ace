# Real history import verification

This revision addresses real-data audit items 3, 4, 5 and the imported-thread part of 15.
All writes, imports, browser sessions and migration tests used temporary homes or the fake service.
No real provider CLI was invoked and no credential file was read.

## Read-only shape checks

The owner's saved conversation directories contained 5,098 Codex JSONL files (largest
1.876 GB), 642 Claude JSONL files (largest 153 MB), 419 legacy OpenCode message files
(largest 176,700 bytes), and 53 Pi JSONL files (largest 2.99 MB). Only conversation
records were sampled; no real text was copied into fixtures. Codex bookkeeping and
encrypted reasoning, Pi headers/branch entries, and oversized legacy OpenCode records
are represented by synthetic records. Skill directory checks found 42 symlinks among
61 Claude skill folders and five symlinks among five Pi skill folders; the Pi fixture
includes a linked skill outside the conversation inventory. The permitted log sample
contained no history diagnostics, so logging was verified through a temporary logger.

## Behavior checks

Each Vitest file was run separately with `--maxWorkers=4`.

- `packages/history-import/src/real-history.process.test.ts`: unreadable legacy records
  only disable their source; attachment envelopes disappear from titles and imported
  text; native copies deduplicate before pagination; readable root and child copies
  beat unsupported copies and import once; Codex raw bookkeeping retains data without
  placeholder text; Pi imports the selected branch despite a linked skill directory.
- `packages/history-import/src/review.test.ts`: existing native-store and incremental
  scan behavior, including database fallback after a duplicate rollout is deleted.
- `packages/history-import/src/history.test.ts`: imported trees are settled and idle,
  while existing import, cancellation, continuation and raw-data behavior is preserved.
- `apps/daemon/src/history-overlap.process.test.ts`: an overlapping list reports
  scanning and later reads the completed catalog; scan failures produce diagnostics.
- `apps/daemon/src/history-migration.test.ts`: old imports without `titleSource` and
  with bare model identifiers settle once, preserving active work and explicit
  user choices to unsettle a thread.
- `apps/daemon/src/history-storage.test.ts` and `history.server.test.ts`: real store
  installation and wire imports expose settled threads.
- `apps/web/src/features/history/past-sessions.test.tsx`: Pi groups and search work,
  imported state is settled, old/new raw notices stay out of the transcript, and the
  scan status leaves available rows usable.

Formatting, lint, root typecheck, source-size, UI and dependency checks passed.
Protocol documentation was regenerated. The full suite is reserved for the orchestrator.

`check:perf` started with host load 5.88 and stopped at the daemon gate: two idle JS
workers (usage and notifications) exceed the one-worker limit. Timing was deferred
after host load reached 14. The idle RSS measurement passed (241.2 MiB in the
subprocess gate; 196.8 MiB in the idle CPU probe). The root command did not reach its
web bundle check. Those services and performance limits were not changed in this
revision. No CSS was added. When load fell to 7.41, the standalone web bundle check
passed: initial JS 260.66 KB, CSS 19.27 KB, thread route 124.55 KB, and client worker
55.42 KB eager / 72.77 KB including lazy chunks. Every route and worker passed its
existing budget.

## Scan measurement

Run `node packages/history-import/bench/real-history.ts`. The fixture has 6,000
conversation sources: 5,950 Codex, 46 Pi, three Claude and one OpenCode session with
a synthetic 180,000-byte legacy message. It is generated and deleted in a temporary
directory. Timing is observational and never a gating assertion.

| Scan       |     Time | Content reads | Skipped unchanged | Peak process RSS |
| ---------- | -------: | ------------: | ----------------: | ---------------: |
| Cold index | 1,170 ms |         6,000 |                 0 |          206 MiB |
| Warm index |   167 ms |             0 |             6,000 |          206 MiB |

The oversized OpenCode source is reported as unsupported. Cold sampling read about
2.85 MB. Peak RSS includes fixture creation and the history worker; it is not daemon
idle RSS. Files may be in the operating system cache, and this is a shared host.

## Screenshots

Run a fake Vite server on port 5298 from `apps/web`, then
`node tools/web-e2e/src/real-history-shots.ts`. The script launches temporary Chromium
contexts and writes to `/tmp/ace-orch/shots/fix-real-history-import/`.
All 36 images were opened and reviewed: compact rows, themed colors, readable narrow
layouts, clean imported messages and a settled imported conversation.

- `08b-scanning-{light,dark}-{1440,390}.png` (four images).
- `08c-past-sessions-{light,dark,midnight,graphite,paper,slate,contrast}-{1440,390}.png`
  (14 images).
- `09-imported-session-{light,dark,midnight,graphite,paper,slate,contrast}-{1440,390}.png`
  (14 images).
- `15-settled-import-{light,dark}-{1440,390}.png` (four images).

## Migration and limits

Catalog format 3 invalidates cached metadata so unchanged native files receive cleaned
titles on the next scan. A one-time store migration emits normal events to settle old
imports only when they have never run, have no active agent, pending interaction,
running background task or queued message, and have no explicit settlement choice.
Raw records and existing conversation data remain intact. The transcript also filters
the exact legacy Codex placeholder notices without requiring destructive data cleanup.

Actual provider resumption and real-data imports were not attempted. The repair will
run in the owner's home only when they start the shipped code. No open design questions
remain within this task's scope.
