# 0092: Triage prompts and bounded doctor repairs

Date: 2026-10-20. Status: accepted.

## Decision

`ace triage` and the app's triage page share portable prompt templates in
`@ace/diagnostics/triage`. The user selects bug investigation, feature planning,
performance investigation or installation repair, describes the issue, reviews the
prompt and hands it to their installed Claude Code, Codex or Cursor CLI. Prompt
construction is deterministic and does not spend provider quota. Diagnostics use the
existing bounded doctor registry and its redaction; no conversation or credential
files are attached. The app also supports editing and copying the generated text.

The terminal wizard works without a daemon. JSON, jq, print and piped input never
launch a provider. Interactive launch passes an argument vector directly to the
installed executable, with an option terminator before the prompt. It retains the
CLI's normal login and permission configuration. No shell interpolation or implicit
installation is involved. The terminal keeps its current working directory; app
support sessions start in the daemon user's home, outside any thread checkout.

The app reuses the daemon's existing owner-scoped live terminal transport. Its
standalone terminal component is supplied by an app-level context shared with
provider sign-in. Launches need administrator scope because they grant a CLI access
to the host outside a registered project. The terminal belongs to the authenticated
socket, closes when the view or socket closes and has no ace transcript or replay.
Unsubscribed launches expire after one minute; subscribed sessions have normal CLI
lifetimes. The existing eight-terminal limit bounds admission. Provider CLIs may
retain their own session history.

`ace doctor` remains read-only. `ace doctor --fix` permits a small, explicit repair
allowlist: create the missing ace home or log folder and restore owner-only directory
permissions. Repairs refuse links, non-directories and foreign ownership. They never
modify SQLite, transcripts, settings, installations or provider credentials. The app
uses the same repair operation from Settings > Advanced. The server checks admin
scope on admission and again before applying repairs or admitting a terminal.

Doctor runs the probes again after repairs. It reports individual outcomes and
retains a failing exit status while failures remain, even after a successful CLI
handoff. Remaining findings can become a triage prompt. Optional missing providers
stay warnings, and the prompt asks which tools the user actually needs. Neither
triage nor doctor files an issue or publishes data automatically.

## Reference boundary

The requested interaction was informed by the public descriptions of T3 Code's
triage command and doctor workflow. No T3 implementation or prompt text was copied.
ace retains its existing diagnostics, redaction, authentication and terminal owners.
