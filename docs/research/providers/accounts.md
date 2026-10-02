# Account home and migration verification

Verified 2026-10-02 against the installed local CLIs. All commands below are read-only help/status/path probes or fork-only operations on synthetic histories. No login was performed during verification, no model prompt was supplied, and the recorder was not run.

## Home selectors

| Provider | Installed version  | Evidence and selection                                                                                                                                                                                                                                                                                                            |
| -------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex    | 0.159.1            | `codex --help`, `exec fork --help`, and the existing [Codex research](codex.md). `CODEX_HOME` selects auth and sessions; `--ignore-user-config` explicitly retains auth from that home. An empty synthetic home reports logged out.                                                                                               |
| Claude   | 2.1.286            | `claude --help`, `claude auth --help`, `claude auth login --help`, and [Claude research](claude-code.md). `CLAUDE_CONFIG_DIR` selects auth/history. Native login supports `--claudeai` and `--console`. An empty synthetic home reports logged out.                                                                               |
| OpenCode | 1.18.33            | `opencode --help`, `debug paths --help`, and an actual `debug paths` probe under synthetic XDG roots. Data/config/state/cache all followed the instance roots and appended `/opencode`. No data-dir flag appears in this help. An empty synthetic home reports zero credentials.                                                  |
| Cursor   | 2026.09.26-dd393fe | `agent --help`, [Cursor research](cursor.md), and read-only inspection of the installed provider's option and credential-store definitions. `--data-dir` is hidden and selects project metadata through `CURSOR_DATA_DIR`; `CURSOR_CONFIG_DIR` selects CLI configuration. These alone do **not** isolate authentication on macOS. |

The Cursor probe initially reported logged in under empty data/config directories because its default credential store uses the global macOS keychain. The installed CLI supports `AGENT_CLI_CREDENTIAL_STORE=file`. Its own file store follows HOME on macOS, XDG_CONFIG_HOME on Linux, and APPDATA on Windows. Supplying that setting and private HOME/XDG/APPDATA roots under the instance made the same empty-home status probe report logged out. ace never opened the auth file or called the keychain. Existing global Cursor logins must be re-established through the native CLI in each isolated instance; they are never copied. This hidden option requires a new probe when the CLI changes. The accounts wrapper reports unknown auth and refuses its login flow on unverified Cursor versions.

These claims use provider APIs and fresh implementations. No competitor code was copied. The official [Cursor CLI configuration](https://cursor.com/docs/cli/reference/configuration) documents the config selector, while the installed CLI was necessary to verify the separate authentication behavior. [OpenCode configuration](https://opencode.ai/docs/config/) explains its configuration hierarchy; the installed path probe verifies the XDG roots. [Claude settings](https://code.claude.com/docs/en/settings) and [fast mode](https://code.claude.com/docs/en/fast-mode) describe CLI-owned settings and speed support. Codex model tier definitions are in `codex-rs/app-server-protocol/src/protocol/v2/model.rs`.

Provider-kit discovery supports explicit CLI path overrides. The machine also has older Homebrew wrappers in PATH, including a broken Codex wrapper, so final probes explicitly selected the working installed Codex and OpenCode paths. ace reports unknown status when a selected wrapper cannot run; it does not infer login from another installation.

## Codex history and locks

Primary source checkout `/tmp/research-codex`, the same provider source referenced by the existing research, was inspected only for behavior:

- `codex-rs/protocol/src/protocol.rs`: session metadata carries stable `id`, root `session_id`, `forked_from_id`, `parent_thread_id`, `history_mode`, and optional `history_base`. History bases reference physical rollout IDs and may differ after reverts.
- `codex-rs/rollout/src/writer_lock.rs`: per-thread `.lock` files live in `thread-writer-locks`, and OS locks plus `.coordination.lock` coordinate writers. ace refuses any matching lock file rather than alter the source to test or remove a stale lock.
- `codex-rs/thread-store/src/local/paginated_fork.rs`: paginated forks load SQLite projections and lineage-dependent model context. Copying only one rollout is insufficient; copying an entire account DB could overwrite unrelated destination histories. These formats need provider-owned materialization and remain unsupported by this implementation.
- `codex-rs/exec/src/lib.rs`: `exec fork` with no prompt chooses `ForkOnly`; an explicit prompt chooses a model turn. This confirms why the verification command must omit the prompt entirely.

`packages/accounts/bench/verify-codex-fork.ts` generated a four-node synthetic legacy fork lineage, migrated it, and invoked the working installed `codex exec fork <id> --skip-git-repo-check --ignore-user-config --ignore-rules --json` without a prompt or stdin. It disabled the optional local thread-store feature for this legacy-format check. The CLI emitted `thread.started`, exited successfully, and wrote a new rollout containing both the original history marker and the migrated parent identity. No `turn.started` or model call was requested.

Compressed files, paginated histories, duplicate physical rollouts after revert, unknown metadata, missing ancestors and cyclic lineage all fail closed. Successful legacy copies preserve full file bytes and native paths. Sibling sessions reuse verified identical ancestor files; a differing destination is refused.

## Other portability

Claude stores the root JSONL and subagent JSONL/meta sidechains in the layout documented in [Claude research](claude-code.md). Tests copy both under the original project slug and verify source and destination hashes.

Installed OpenCode help advertises `export [sessionID]` and `import <file>`, including a sanitized export option. The existing [OpenCode research](opencode.md) identifies parent/child sessions and rapidly changing SQLite storage. A single-session export does not establish complete tree fidelity or writer exclusion, so native migration remains unsupported pending that evidence. No provider DB is copied.

The [Cursor research](cursor.md) identifies ACP `acp-sessions/<id>/store.db` and observed unsupported resume/fork methods. Transcript copying cannot establish ACP store portability. Cursor migration returns unsupported with a reason.

The accounts package requires the engine to hold a lease excluding all source/destination writers, including independently launched CLIs, through publication. Provider lock presence is a second check. This requirement is deliberate: absence of a lock file or one process-list sample cannot establish race-free quiescence.
