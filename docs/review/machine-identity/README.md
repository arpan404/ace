# Machine identity and informative tasks

The default task row is 36 px tall with two lines of information. It shows the title and unread activity beside live status or age. The second line carries the project mark, branch, remote machine when applicable, PR state, changes, running agents and the 14 px provider mark. Only selection fills a row. Working marks pulse; reduced motion disables animation. Existing list motion handles reordering.

Requests sort first, working tasks next, then other tasks by recency. Pins retain the person's order; settled work stays dimmed and compact. Empty drafts never enter the task list or its project counts, even after renaming. Old titled tasks remain compatible until their host supplies the sent-message fact.

Settings > Remote devices edits the host-owned machine name and mark. The default name comes from the macOS computer name. Clearing a custom name restores that default. Connected paired hosts save their own identity; the directory caches their latest identity for offline labels. Shared machine labels use current identity instead of stale thread metadata, including the legacy local hostname alias.

OpenCode's original mark included a filled favicon backdrop. The shared generated artwork removes that backdrop, retains the cutout, and maps monochrome ink to the theme. All artwork uses bounded view boxes and scales at small sizes. The render check examines rasterized pixels with padding around the original viewport so clipping cannot hide overflowing paths.

## Review images

All images use the fake daemon and synthetic projects. Originals and each individual preset are in `/tmp/ace-orch/shots/feat-machine-identity/`.

| Review                                | Light                                      | Dark                                      |
| ------------------------------------- | ------------------------------------------ | ----------------------------------------- |
| Tasks, 1440 px                        | [Screenshot](tasks-light-1440.png)         | [Screenshot](tasks-dark-1440.png)         |
| Tasks, 390 px                         | [Screenshot](tasks-light-390.png)          | [Screenshot](tasks-dark-390.png)          |
| Denser, default and roomier           | [Comparison](density-comparison-light.png) | [Comparison](density-comparison-dark.png) |
| Machine editor, 1440 px               | [Screenshot](editor-light-1440.png)        | [Screenshot](editor-dark-1440.png)        |
| Machine editor, 390 px                | [Screenshot](editor-light-390.png)         | [Screenshot](editor-dark-390.png)         |
| Every provider mark at 16 px, 1440 px | [Screenshot](providers-light-1440.png)     | [Screenshot](providers-dark-1440.png)     |
| Every provider mark at 16 px, 390 px  | [Screenshot](providers-light-390.png)      | [Screenshot](providers-dark-390.png)      |

[Every theme preset at both widths](task-review.png). Density alternatives are screenshot previews only; the default ships without an extra setting.

## Protocol and performance

Additive optional fields preserve older hosts and clients:

- `host.icon`, `HostIdentity.icon`, cached machine directory icons and thread machine icons.
- `hasSentMessage`, sticky after admitted user input, with a one-time retained-item migration.
- `activitySeq`, compared with the existing per-device `thread.readState` cursor.
- `live.workingSince`, stable across streaming and agent-count changes, persisted across restarts.
- `live.runningSubagentCount`, updated from single-agent status changes and seeded once from existing materialized agents.
- `details.linkedPr.draft`, preserving forge draft state alongside open, merged and closed states.

The sidebar reads device cursors only for mounted rows and execution/read changes. Working rows share one visible-page clock. Counts use indexed entity reads, never transcript scans. The idle benchmark now walks bounded event pages to find its scripted answer instead of assuming it appears within the first 16 events.

Measured bundle sizes were 268.19 KB initial JavaScript, 19.21 KB CSS, 121.59 KB for the thread route and 72.73 KB for the client worker including lazy chunks. Budgets were not raised.

The performance command passed bundle, daemon memory/reliability and browser streaming, long-thread and retained-memory checks. Daemon timing qualification was deferred when shared host load reached its threshold. Device performance was skipped because the desktop was locked; human input latency remains unqualified.

Read-only verification found no custom host name or icon in the owner's ace settings. The OS computer name was available. Bounded CLI metadata inspection confirmed mixed message/event arrays and OpenCode's session/message/part tables. No credentials, real provider requests or live ace writes were used.
