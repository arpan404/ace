# Fake audit scenarios

`uxAudit()` returns the chat UX audit fixtures and `devWorld()` seeds them by
default. `uxAuditScreens` exports their stable thread ids, titles and `/t/...`
paths for the screenshot runner. No fixture starts a provider, reads a host file,
or writes to an ace home.

| Route suffix after `/t/thread-ux-` | Behavior                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `question-steer`                   | A pending Codex async question. Answering resumes the script with an origin-tagged label echo. |
| `question-steer-answered`          | The resolved question, selected option and hidden model-facing echo remain in history.         |
| `wrapped-commands`                 | Readable inner command plus the original zsh wrapper.                                          |
| `absolute-paths`                   | Current worktree, other worktree and home paths.                                               |
| `skill-reads`                      | An absolute skill read.                                                                        |
| `switch-handoff`                   | An applied provider switch and a separate handoff input.                                       |
| `delegation-results`               | A parent receives origin-tagged failed child results.                                          |
| `delegated-model-error`            | A task from the parent and one structured unknown-model error.                                 |
| `interrupted`                      | An interrupted run keeps partial assistant text.                                               |
| `auth-error`                       | One structured sign-in failure with its terminal error.                                        |
| `pending-full-access`              | An approval under effective Auto-review while Full access is pending.                          |
| `restart-continuation`             | A restart continuation stays separate from the person's input.                                 |
| `failed-commands`                  | Repeated failing commands followed by one successful retry.                                    |
| `changed-files-mid-turn`           | An edit and progress message precede a still-running command.                                  |

The shapes follow the checked-in Codex 0.159.1 question/tool-read recordings and
Claude 2.1.286 question/interrupt/tool-read recordings. Error and handoff cases
follow the audit's real-daemon observations and canonical contracts.

New create/send commands write original input once under `input:<commandId>`
with `origin.kind = person`. Repeated command ids return the original receipt.
Provider turn simulation does not invent another user message or an assistant
reading bubble. Creates use the supplied title, falling back to `New thread`;
the UI and real daemon own provisional-title generation.

The screenshot runner should iterate `uxAuditScreens` in both themes. Its current
explicit screen list is outside WP6's file ownership; wiring that loop belongs
to the UI integration work.
