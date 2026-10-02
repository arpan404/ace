# 0005: Adapters are tested against recorded provider sessions

Date: 2026-10-02. Status: accepted.

## Context

Every provider ships weekly or faster, and their docs lag their code. Several behaviours we depend on (idle signals, subagent event ordering, background-task completion) can only be confirmed by watching real sessions.

## Decision

- `tools/recorder` runs a fixed set of scripted scenarios against the user's installed CLIs and records every raw frame in both directions, with timestamps, into JSONL.
- Scenarios are the same across providers wherever the provider supports them: single tool call, approval, question, plan review, foreground subagent, background subagent, background shell, interrupt mid-tool.
- Scenarios run in a throwaway git workspace containing only synthetic files. Recordings are redacted (home directory, user name, emails, tokens) before they are committed under `fixtures/<provider>/<cli-version>/<scenario>.jsonl`.
- Adapter tests replay fixtures and assert the canonical events and the derived status at each point.
- Recording spends the user's provider quota, so it only runs when explicitly requested.

## Consequences

- A CLI upgrade means re-recording and reviewing the diff of canonical output, which shows exactly what changed.
- Fixtures from different CLI versions accumulate; old ones are deleted when we drop support for that version.
