# 0001: Clean-room rewrite under Apache-2.0

Date: 2026-10-02. Status: accepted.

## Context

The previous ace codebase was derived from t3code (MIT, © T3 Tools Inc.). Its data model is a flat session → turn → item stream shaped around Codex. Subagents from OpenCode, Claude and others are lost or flattened. Threads show "completed" while subagents, background shells or pending approvals are still active. Fixing that needs a different core model, and we want a codebase whose copyright is entirely our own.

## Decision

- Start a new repository with fresh git history. The old repository is archived as `arpan404/ace-legacy` at tag `legacy-final`.
- Nothing is copied from t3code or ace-legacy. Other projects may be read to learn which provider interfaces exist; implementations are written from our own specs and primary provider sources.
- License: Apache-2.0.
- The repository stays private until the first usable release.

## Consequences

- No legacy code to carry, but also nothing to reuse: every feature is rebuilt.
- Research notes record provenance (which primary sources each claim came from), so the clean-room boundary can be shown later.
