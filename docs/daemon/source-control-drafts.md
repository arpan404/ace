# Source-control drafts

The commit and PR dialogs offer **Generate draft**. Choose Codex CLI or Claude
Code CLI under Draft writing options, optionally enter a native model ID and a
writing preference, then generate. These choices apply to that request only.
Generation uses the CLI's normal local login and the configured daemon executable
and default model. It does not change the thread's provider or account.

Review the proposal and its Sources before choosing **Use draft**. Subject and
body remain editable in the form. Generating never commits, stages the real
index, pushes or creates a PR. The existing submit buttons perform those actions.
Typing during generation prevents the proposal from replacing that text. Changing
selected files after applying a proposal blocks submission until another draft is
applied or **Discard draft tracking** explicitly releases its source guard. The
latter retains the person's text and treats it as a manually reviewed message.

## Sources and revisions

GitService builds a temporary index from HEAD and adds only the selected literal
paths, including untracked files and both sides of renames. It never changes the
real index. PR context uses the merge base and committed branch head, excluding
uncommitted working-tree bytes. It includes the thread title and a bounded recent
page of person/assistant text for intent, without issuing another provider request.
The recorded Git base ref travels separately from the forge branch name: a base
on `origin/release` compares against `refs/remotes/origin/release`, while the PR
targets `release`. A divergent local namesake cannot replace that remote base.
Submission uses the same Git base ref when validating the applied draft.

Both modes include the last twelve commit subjects, root and relevant nested
AGENTS.md files, and optional `.ace/source-control.md` writing instructions. Commit
mode reads the configured `commit.template` when it is a regular file inside the
checkout. PR mode reads `.github/PULL_REQUEST_TEMPLATE.md`, its lowercase spelling,
and root `PULL_REQUEST_TEMPLATE.md`. Symlinks and outside-checkout templates are
excluded. Instruction/template content is evidence for writing conventions, not
authority to execute actions. Named PR template selection is not offered yet.

A source fingerprint includes immutable revisions, selected paths and convention
text. Patch output is capped at 64 KiB, convention text at 16 KiB, recent subjects
at 8 KiB and PR thread context at 8 KiB. Truncation is visible beside the source
diff. Binary changes still participate in the tree fingerprint. The daemon checks
the fingerprint before and after generation, and before publishing an applied
draft. Commit validation shares the Git mutation lease with the actual commit.
PR submission validates before the existing push action and again before create.
The final PR check belongs to the forge publication owner, after its existing-PR
lookup. Validation and creation share the checkout's Git mutation lease, so daemon
commits and pushes on that checkout wait until the guarded create settles. A
changed source discovered after lookup refuses creation. Existing PRs still link
through the durable receipt path without submitting the draft text again.
Generation does not freeze files against edits made by external programs.

## CLI boundary

A draft is one ephemeral writing subprocess owned by the workspace service,
not a coding turn or a continuation of the thread. The canonical agent tree is
untouched. It uses provider-kit discovery and process-group supervision, injected
at the daemon boundary. No credentials are read, copied or persisted by ace.

Claude runs print mode with safe mode, no built-in tools, no MCP tools or servers,
no slash commands, no session persistence and one maximum turn. Codex runs exec
outside the checkout with user configuration ignored, MCP/shell/agent/app
tools disabled and patch commands restricted by a read-only sandbox. Authentication remains in its normal CLI
home. Unsupported CLI flags fail visibly without falling back to a coding run.
This first version supports the two CLIs with these explicit one-shot contracts.
OpenCode, Cursor, Pi and ACP drafting require separate tool-free contracts.

Input goes on stdin. Output has a 1 MiB aggregate cap and a two-minute deadline.
Provider output is schema-validated; malformed, failed or incomplete results are
refused. Unknown Codex events/fields are accepted and do not establish completion.
Only a completed turn's final message can become a draft. Errors use fixed codes
and never include CLI diagnostics. Cancellation stops the owned process group.
Disconnect or dialog closure cancels the request; reconnect never regenerates it.
A daemon restart loses the ephemeral request and requires another explicit click.
Generation requires operate authority; source reads require read authority.
Cancellation is scoped to the requesting socket and thread.

Primary CLI references:
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
[Codex CLI reference](https://developers.openai.com/codex/cli/reference), and
[Codex configuration reference](https://developers.openai.com/codex/config-reference).
