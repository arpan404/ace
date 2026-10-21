# 0092: CLI triage and bounded doctor repairs

Date: 2026-10-20. Status: accepted.

## Decision

`ace triage` is a CLI-only wizard. Portable prompt templates live in
`@ace/diagnostics/triage`. The user chooses bug investigation, feature planning,
performance investigation or installation repair, describes the issue, reviews the
prompt and hands it to their installed Claude Code, Codex or Cursor CLI. Prompt
construction is deterministic and makes no model call. Diagnostics use the existing
bounded doctor registry and redaction; no conversation or credential files are attached.
There is no app triage route or provider-launch operation in diagnostics.

The wizard works without a daemon. JSON, jq, print and piped input never launch a
provider. Interactive launch passes an argument vector directly to the installed
executable, with an option terminator before the prompt. It retains the CLI's normal
login and permission configuration and current working folder. No shell interpolation
or implicit installation is involved. Provider CLIs may retain their own session history.

`ace doctor` remains read-only. It reports integrity, allocated database pages,
reusable pages and WAL bytes. `ace doctor --fix` creates missing ace/log folders
and restores owner-only directory permissions. Folder repairs refuse links,
non-directories and foreign ownership. Settings > Advanced uses these folder repairs
through an admin-only diagnostics operation, with authority checked again before writes.

The CLI can also reclaim space when integrity passes and reusable pages or WAL size
cross the diagnostic thresholds. It calls the running local daemon's existing storage
compaction operation. That owner supplies the maintenance fence, incremental vacuum,
resumable journal, bounded chunks and WAL checkpoint. Doctor never opens an offline
database for writes, deletes WAL files or runs full VACUUM. Legacy databases with
`auto_vacuum=NONE` keep their reusable pages and need a rowid-preserving migration to
shrink. Rebuilding them implicitly could renumber row IDs referenced by stored frames
and receipts. Corruption stays a failure requiring preservation and backup restoration.

Doctor reruns probes after repairs, reports individual outcomes and retains a failing
exit status while failures remain, even after a successful CLI handoff. Remaining
findings can become a triage prompt. Optional missing providers stay warnings, and the
prompt asks which tools the user needs. Neither command publishes data automatically.

## Reference boundary

The requested interaction was informed by public descriptions of T3 Code's triage
command and doctor workflow. No T3 implementation or prompt text was copied. ace
retains its existing diagnostics, redaction and storage owners.
