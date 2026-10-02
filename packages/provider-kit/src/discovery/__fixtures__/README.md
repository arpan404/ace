# Read-only CLI captures

Recaptured on 2026-10-02 from the current user's PATH after checking `command -v` and running `--version` first. No sessions or prompts ran during capture.

| CLI        | Version            | Version stream | Status command       | Auth stream                  |
| ---------- | ------------------ | -------------- | -------------------- | ---------------------------- |
| `claude`   | 2.1.286            | stdout         | `claude auth status` | stdout                       |
| `codex`    | 0.159.1            | stdout         | `codex login status` | stderr, stdout empty         |
| `opencode` | 1.18.33            | stdout         | `opencode auth list` | stdout, ANSI reset on stderr |
| `agent`    | 2026.09.26-dd393fe | stdout         | `agent status`       | stdout                       |

Each capture keeps exit code, signal, stdout, stderr, and an ordered `lines` array with a `stream` tag for every line. Emails, usernames, paths and organization identifiers are redacted before writing the files. ANSI codes are preserved. No credential files were read.

All four CLIs succeeded. Codex and the other status commands report logged in. OpenCode reports configured credentials for GitHub Copilot, OpenCode Go and LMStudio; remote access is unvalidated.

`codex-broken-install.json` is a labelled error-case capture retained from the prior run. That environment resolved the Homebrew wrapper instead of the user's Bun-installed Codex. Its attempt to spawn the packaged executable failed with ENOENT. It does not describe the working user installation. The previous OpenCode capture likewise used the Homebrew binary instead of the user's `.opencode/bin` binary. The current captures use the user's working PATH selections.

Tests replay these stream-specific captures through real shell CLI stand-ins and `discoverProviders`, including Codex's empty stdout with stderr status. Extra ANSI tests put escape sequences inside meaningful words so removing ANSI stripping changes the observed auth result.
