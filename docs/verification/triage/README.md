# CLI triage verification

Triage is CLI-only. The screenshots show the actual `ace triage` process in a
PTY-backed browser terminal, using a temporary ACE_HOME. No provider session was
launched. Native Terminal access was unavailable in this session.

![Choosing a prompt template with arrow keys](terminal-wizard.jpg)

![Reviewing the generated prompt](terminal-preview.jpg)

![Choosing an installed CLI after review](terminal-handoff.jpg)

Arrow keys and Enter select a template or CLI. The description supports multiline
editing; pressing Enter twice submits it, and Ctrl-C cancels. The prompt preview
contains the task and description. Setup diagnostics appear only for the doctor
template, as findings and a passed-check count.

Process tests use temporary homes and local stub executables. They cover literal
prompt arguments, arrow-key selection, cancellation, terminal input and exit status,
prompt generation without a daemon,
folder repairs that preserve data, refusal of linked targets and admin-only app folder
repairs. Triage has no app route, profile entry or diagnostics launch operation.

Database tests exercise real SQLite files. Doctor detects deleted-row free pages and
reclaims over 2 MiB through the running daemon while preserving surviving row IDs and
payloads, even when a remote CLI profile is selected. Legacy databases retain
reusable pages and row IDs. Offline and corrupt files remain byte-identical after `doctor --fix`. A pinned reader keeps its WAL and
snapshot; after it closes, a second repair truncates the WAL without losing rows.
Existing storage tests also cover write fencing, interrupted compaction recovery, pending work and legacy row IDs.
