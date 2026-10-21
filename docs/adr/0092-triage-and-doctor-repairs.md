# 0092: CLI triage and bounded doctor repairs

Date: 2026-10-20. Status: accepted.

## Decision

`ace triage` is a CLI-only wizard. Portable prompt templates live in
`@ace/diagnostics/triage`. The user chooses bug investigation, feature planning,
performance investigation or installation repair, answers that template's main
question and one optional follow-up, reviews the prompt and hands it to their
installed Claude Code, Codex, Cursor CLI or OpenCode, copies it or prints it. Prompt
construction is deterministic and makes no model call.

A handoff is only useful if the agent can see what the person saw, so every prompt
carries local evidence: the last 24 hours of ace warnings and errors, grouped by
message with counts and one shortened sample; whether the local daemon is running;
which agent CLIs are installed and their versions; and where ace keeps its logs and
data, with the instruction to read but never write the live SQLite files. The log
digest reads only the tail of the log file and is pure (`digestLogLines`, clock
injected). Messages and samples pass through the text redactor for secret-looking
environment values, ids and emails; home paths are shown as `~` because the agent runs
on the same computer and needs them. Only the installation-repair template runs doctor
checks; it lists findings and summarizes successful checks without raw JSON. No
conversation or credential files are attached.
There is no app triage route or provider-launch operation in diagnostics.

The wizard works without a daemon. JSON, jq, print and piped input never launch a
provider. Interactive launch passes an argument vector directly to the installed
executable: an option terminator before the prompt, or OpenCode's `--prompt=` flag
because OpenCode reads a positional argument as its start folder. Cursor resolves
`cursor-agent` before the generic `agent`. While the CLI runs, ace ignores SIGINT so
Ctrl-C interrupts the agent's turn rather than killing ace, and forwards SIGTERM and
SIGHUP. It retains the CLI's normal
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

While ace's own daemon is running it holds the loopback port, so the CLI drops that
expected port warning instead of reporting it or handing it to an agent.

Doctor reruns probes after repairs, reports individual outcomes and retains a failing
exit status while failures remain, even after a successful CLI handoff. Remaining
findings can become a triage prompt. Optional missing providers stay warnings, and the
prompt asks which tools the user needs. Neither command publishes data automatically.
