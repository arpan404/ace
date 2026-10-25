# 0103: Skill library: managing native skills

Date: 2026-10-25. Status: accepted.

## Context

The Skills page managed only ace plugins. Skills in agent folders (`~/.claude/skills`, `~/.agents/skills`, `<project>/.claude/skills`, …) showed a title, description and path, discovered one provider at a time through `catalog.list`. People keep one folder and link it into each agent (`~/.claude/skills/x -> ../../.agents/skills/x`), so the same skill showed up once per agent, without its instructions, without who loads it, and with no way to change it.

ADR 0069 (catalog and mentions), ADR 0014 (plugins), ADR 0002 (no credentials) and ADR 0003 (schema-only protocol) still apply.

## Decision

A skill library in `@ace/commands`, behind one request family in `@ace/protocol` (`skill-library.ts`):

- `skills.request {requestId, operation}` answered by `skills.result {requestId, result}`.
- Operations: `list` (optional `workspaceId`, optional `subscribe`), `read`, `create`, `edit`, `setAgents`, `delete`, `checkUpdate`, `prepareUpdate`, `applyUpdate`, `cancelUpdate`, `usage`.
- A subscribed list receives `skills.changed {requestId, entries}` snapshots; `skills.unsubscribe` or disconnect ends it.
- Errors are typed: `not_found`, `conflict` (stale hash), `exists`, `invalid`, `limit`, `read_only`, `forbidden`, `update_failed`, `unavailable`.

Reads need the device read scope; every mutation needs operate.

### Entries

One entry per skill directory, deduplicated by realpath across every agent's roots. Fields: `id` (`skl_` + SHA-1 of the canonical realpath, so it survives restarts and never carries a path), `name`, optional `title` (leading `#` heading), `description`, `scope` (`project | personal | plugin | builtin`), display `path` (home as `~`, project skills relative to the project), `agents`, `manual`, optional `argumentHint`, `editable`, optional `source`, and `hash` (SHA-256 of SKILL.md).

`agents` lists `{provider, via, path, removable, honoursManual}`:

- `native`: the canonical folder sits in a root this agent reads.
- `link`: a symlink in a root this agent reads resolves to the canonical folder.
- `copy`: this agent has a separate real folder with the same name.

Clients send ids, never paths. The daemon resolves an id by listing the roots again.

### Where each agent reads skills

ace only links into these roots. Facts are from each agent's docs; `roots.ts` already lists the provider-owned folders.

| Agent    | Personal roots read                                                           | Project roots read                                                    | Link root (personal / project)                   | Source                                                                                           |
| -------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Claude   | `$CLAUDE_CONFIG_DIR/skills` (`~/.claude/skills`)                              | `.claude/skills`                                                      | `~/.claude/skills` / `.claude/skills`            | [Claude skills](https://code.claude.com/docs/en/skills)                                          |
| Codex    | `~/.agents/skills` (+ `$CODEX_HOME/skills`, kept from `roots.ts`)             | `.agents/skills` (+ `.codex/skills`)                                  | `~/.agents/skills` / `.agents/skills`            | [Codex skills](https://learn.chatgpt.com/docs/build-skills)                                      |
| OpenCode | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`           | `.opencode/skills`, `.claude/skills`, `.agents/skills`                | `~/.config/opencode/skills` / `.opencode/skills` | [OpenCode skills](https://opencode.ai/docs/skills/)                                              |
| Cursor   | `~/.cursor/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` | `.cursor/skills`, `.agents/skills`, `.claude/skills`, `.codex/skills` | `~/.cursor/skills` / `.cursor/skills`            | [Cursor skills](https://cursor.com/docs/context/skills)                                          |
| Pi       | `~/.pi/agent/skills`, `~/.agents/skills`                                      | `.pi/skills`, `.agents/skills`                                        | `~/.pi/agent/skills` / `.pi/skills`              | [Pi skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md) |

ACP and Antigravity have no skill root ace knows; they keep receiving skills by injection (ADR 0069). Builtin skills report every agent as `native` (shipped to Claude, Codex, OpenCode and Pi natively and injected elsewhere).

A skill saved in `~/.agents/skills` is therefore always seen by Codex, OpenCode, Cursor and Pi. Those agents are listed `removable: false`; only Claude needs a link.

### Manual skills

`manual` is the frontmatter `disable-model-invocation: true`. Claude, Cursor and Pi honour it. Codex uses `agents/openai.yaml` `policy.allow_implicit_invocation: false` instead and ignores the frontmatter; OpenCode has no per-skill switch (only `permission.skill` deny/ask in its config). Entries report this per agent as `honoursManual`. ace v1 writes only the frontmatter: it does not write Codex's `openai.yaml` or OpenCode's config. The skill page says so: when an agent with the skill ignores the flag, it names the agents that honour it and those that may still load it ("Claude Code never loads it by itself. Codex and OpenCode may still load it.").

### Create, edit, agents, delete

- Create: `name` must be a slug (`^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64). The canonical folder is `~/.agents/skills/<name>` or `<workspace>/.agents/skills/<name>`. For each chosen agent that doesn't read that root, ace adds a relative symlink in its link root (`~/.claude/skills/<name> -> ../../.agents/skills/<name>`). A name already used by a skill in the same scope (any agent folder) is refused with `exists`. Built-in and plugin skills and the other scope don't block a name; the web form checks the same rule and the daemon's `exists` stays the source of truth.
- Edit: `expectedHash` plus `description`, `body` and `manual`. The YAML document editor from `prompt-edit.ts` keeps unknown keys and comments. The name is read-only. Writes go to a temporary file then rename, and the hash is checked before and after.
- Set agents: adds links for added agents and removes links for removed ones. ace never removes a `copy`, the agent whose root holds the canonical folder, or a link in a root another selected agent still reads (`shared`). These come back in `kept` with the reason.
- Delete: needs `expectedHash`. It removes the canonical folder and every symlink in a known root that resolves to it. Only for `editable` entries.

### Update from source

Skills installed by the `skills` CLI are recorded in `~/.agents/.skill-lock.json` (version 3: per name `source`, `sourceType`, `sourceUrl`, `skillPath`, `skillFolderHash`, timestamps). `skillFolderHash` is the Git tree SHA of the skill folder. ace reads only GitHub entries whose lock name matches the folder. A skill at the repository root (`skillPath: "SKILL.md"`) uses folder `.`: the root tree's SHA and the whole repository's files.

- `checkUpdate` fetches the source's default branch (`HEAD`) with the plugin Git fetcher (`@ace/plugins` `fetchRepository`, shallow bare fetch, isolated config, no hooks), then compares the folder's tree SHA at that commit with the lock.
- `prepareUpdate` extracts the folder into a private staging directory, where symlinks and submodules are refused. It returns a review: added, changed and removed files, a flag on every file that is executable or isn't Markdown or text, SKILL.md before and after, and `baseHash`, the installed SKILL.md hash it compared against. ace also keeps a fingerprint of every installed file (path, content hash, executable bit). Files are hashed in 64 KiB chunks; a folder over 512 files, 16 levels, 4 MiB per file or 16 MiB in total is refused with `limit`.
- `applyUpdate` needs the review id and the review's `baseHash`. Right before the swap it fingerprints the installed folder again; any change since the review, to SKILL.md or any other file, is a `conflict` and nothing changes. It builds the new folder beside the old one (`.<name>.ace-update-<token>`), renames the original to `.<name>.ace-old-<folderHash>-<token>` and the new folder into place, then sets the lock entry's `skillFolderHash` and `updatedAt`, leaving its other keys alone. The original is removed only after the lock write commits; if the lock write fails the original goes back and the error says nothing changed.
- On start, ace removes leftover `.ace-update-` folders and settles each `.ace-old-<folderHash>-` backup: if the lock already records that `folderHash` the update stands and the backup is removed, otherwise the original goes back in place.
- `cancelUpdate` drops the staging directory. Reviews are in memory and expire after 30 minutes or on restart.

Nothing from the fetched repository is executed.

### Usage

`usage` returns, per id, how many of the person's messages mentioned the skill and the most recent thread `{id, title, at}`. The daemon's `skill_usage` table holds one row per (message, skill name). The row is written when the message item is stored, and goes away with the message or thread. Schema 18 creates the table and backfills it once from stored user messages. Synthetic messages and fork copies are not counted. Reads are two indexed lookups per name; history is never scanned. Mentions are matched by name because catalog entry ids differ per agent.

### Listing and change notices

A list inspects the known roots: it reads each direct child's type, resolves its link and reads its SKILL.md. Nothing below that is walked. Change notices reuse `CommandFiles`, the catalog's watcher and recovery loop, over the same roots: one set for personal roots and one per subscribed project. No new scanner or watcher type is added. A subscription pushes a new snapshot only when the entries differ. Installed ace plugins notify through the plugin manager's catalog subscription.

Plugin entries come from the plugin manager's catalog. They are listing-only (`read` answers `read_only`) because the plugin pages already own their files and review.

## Safety

- Writes happen only inside the skill roots in the table above, containment-checked after realpath. Writes never follow a symlink out of a root: the canonical folder must resolve inside a writable root, and links are created only as direct children of a link root.
- Create, edit, delete and update apply work through descriptors: the root's resolved path is opened from `/` one component at a time and the skill folder relative to it, all with `O_NOFOLLOW`, and every file write, rename and removal is relative to those descriptors (`skill-disk.ts`, on the `posix.ts` primitives the catalog uses). A folder swapped for a symlink mid-operation can't redirect a write or delete outside the root.
- Names that aren't slugs are refused, as is SKILL.md over 256 KiB.
- Plugin, builtin and anything outside the writable roots is `editable: false` and refused with `read_only`.
- ace never reads credential or settings files; only `SKILL.md`, folder entries and the `skills` lock file.
- The only network use is the Git fetch for updates, run on explicit request.
- Decisions (presence, agent changes, update diffs, frontmatter edits) are pure functions. Filesystem, Git, clock, ids and roots are injected.

## Limits

Codex `openai.yaml`, OpenCode permissions and Antigravity roots are not written. The library shows only skills in roots on this machine; account-synced Claude skills (`~/.claude/skills/synced`) are listed as personal Claude skills. Renaming is out of scope.
