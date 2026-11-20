# 0193: Each thread has one editor, and every file opens there

Status: proposed. Date: 2026-11-19. Decided by: pending the owner. Builds on
[ADR 0178](0178-rust-files-and-editor-core.md) (Rust files and editor core). The spec, audit and
mockup are in [docs/editor/workbench.md](../editor/workbench.md).

## Context

Today every checkout file opens as its own side-panel tab (`files:file:<path>`), each with its own
tree, toolbar and read-only/edit mode, in the same strip as Summary, Changes, Browser and
terminals. The editor's document is created by the view that shows it, so hiding a tab frees its
buffer and undo history, and unsaved text is stored inside the tab's data in `localStorage`.

A hands-on audit on 2026-11-19 (spec, "UX audit") found the costs: three open files push earlier
ones out of the strip; files open about 360px wide; editing needs a mode switch that save undoes;
unsaved state shows only inside the file; and when an agent wrote a file the person was editing,
nothing said so until Save, which then offered only to overwrite the agent's change.

The owner asked for a real editor: many files in one editor area with its own tabs and splits, the
Files explorer kept for quick lookups, and a better UX than today's.

## Options considered

- **Keep per-file panel tabs and add splits to the side panel.** Every tool would inherit editor
  rules (preview, dirty, groups) it has no use for, and files would still share a strip with tools.
- **A workbench for editing plus a separate single-file view for quick lookups and chat mentions.**
  One file could then be open in two places with two unsaved states that disagree; the person learns
  two tab models.
- **The editor as the main column, the chat in the panel.** Inverts ace's chat-first layout for
  every thread, including those that never open a file.
- **One editor per thread as a panel tab; every open goes there; a glance is a preview tab.**
  Chosen: one home per file, the explorer is the editor's own sidebar (so today's Files lookup keeps
  its feel at panel widths), and the panel system needs no new cases.

## Decision

1. **A thread with a checkout has one Editor panel tab, a singleton kind.** It holds an explorer
   (Files and Search), an editor area of groups in a split tree, each with its own tab strip, and
   one status line. It replaces the pinned Files tab and every per-file panel tab; files never
   appear in the panel strip.
2. **Every checkout-file opener goes through one function into the focused group.** A glance
   (single click, search hit, chat mention, agent tool row) opens or replaces the group's one
   preview tab; a deliberate open keeps the tab. Beside the chat the editor is compact (one group,
   explorer stepped aside); that is the quick one-file view, not a second component.
3. **One buffer per path per thread, owned by a buffer registry, not by views.** Views of the same
   path in several groups share it. Only each group's active editor renders, and only its visible
   rows. Hidden, saved buffers are freed least recently shown first above a 64 MB cap; unsaved and
   visible buffers never are.
4. **Files are always editable; unsaved text lives in a draft store in IndexedDB**, keyed by
   machine, thread and path with its base version, not in tab data. Switching threads and quitting
   never prompt while drafts are kept; closing an unsaved editor asks.
5. **An agent's change to a file the person is editing is raised at once, and merged, not
   overwritten.** A three-way merge (base: the version the person started from) joins `native/editor`;
   overlapping blocks are answered per block. Replace remains only as an explicit answer.
6. **The layout is local UI state**, stored per thread in the workspace store like panel tabs today,
   and migrated once on the client from stored per-file tabs. Nothing changes in the daemon or the
   protocol for this decision.
7. **The rules live as a pure model in `@ace/ui-core`** beside `workspace-tabs.ts`, so the iPad can
   adopt them later; the iPhone keeps its single-file view.
8. **Language intelligence (LSP) is a separate later decision.**

## Consequences

- Easier: one place to see what is open and unsaved; agents' edits are visible where the person
  works; splits and keyboard flows without touching the panel system.
- Harder: the registry, draft store and merge are new moving parts with their own failure modes
  (storage full, a merge with no base version after eviction; the spec defines both).
- Required: a client-side migration of stored per-file tabs; an `editor` keymap scope whose ⌘1–⌘9
  may shadow "Open thread 1–9" while focus is in the editor (open question in the spec); a web perf
  test holding the budgets in the spec.
- Accepted: freeing a hidden saved buffer drops its undo history; layouts do not sync across
  devices.

## Tests

- Unit tables for the pure model in `@ace/ui-core` (preview replacement, pinned tabs surviving
  close variants, group pruning, migration order and flags, lenient parse of a corrupt layout).
- Registry tests: two views share one buffer; eviction order and cap; drafts survive a reload and
  are removed on save.
- Rust tables for the three-way merge.
- One process test: a chat mention opens a preview tab in the thread's editor; an external write
  to an unsaved file raises the merge line; reload restores layout and drafts.
- A `test:slow` web perf test for the spec's budgets (100 tabs, two groups).
