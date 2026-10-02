# Read-only CLI captures

Captured on 2026-10-02 from this machine, without starting agent sessions. Each JSON file contains stdout, stderr and exit code for `--version` and the provider's read-only status command:

- Claude: `claude auth status`
- Codex: `codex login status`
- OpenCode: `opencode auth list`
- Cursor: `agent status`

Emails, usernames, paths and organization identifiers are replaced with placeholders. ANSI codes remain in the OpenCode capture so its parser exercises the real terminal output. No credential files were read.

Codex's PATH wrapper could not launch its target binary, so its captured version and auth output are errors. The tests cover successful Codex status responses with explicitly synthetic strings. The other captures show Claude 2.1.286, OpenCode 1.18.4 and Cursor 2026.09.26-dd393fe logged in. Configured OpenCode credentials do not establish that every upstream provider will accept them.
