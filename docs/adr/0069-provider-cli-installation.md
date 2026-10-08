# 0069: Provider CLI installation through reviewed official methods

Date: 2026-10-07. Status: accepted by the owner's installation request.

ace installs, updates and removes local provider runtimes through a versioned code manifest. Each entry names the official package, formula or script and links its primary source. The pure manifest and command construction live in `@ace/provider-kit/installers`, shared with the fake daemon; filesystem detection and process supervision stay in the daemon. ace does not bundle these CLIs, accept remote command text, implement its own updater, or handle provider credentials. Cursor's official SDK remains an ace dependency under ADR 0043, so its plan points to sign-in and SDK updates ship with ace.

An install method identifies who owns the executable: npm, Bun, Homebrew or a vendor script. Planning resolves the user's launch PATH and explicit binary setting, follows symlinks, and compares the result with package-manager roots and documented script destinations. PATH wins over the documented per-user script fallbacks, which also keep discovery working after an install changes a shell startup file. Unknown owners, legacy package names and unavailable original managers produce manual instructions. A run cannot switch an existing installation to another method. Uninstall preserves settings, credentials and history; ace does not implement vendor cleanup instructions that delete them.

The reviewed methods and sources are:

| Runtime           | Methods                                                                                  | Official source                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Codex             | npm `@openai/codex`, Homebrew cask `codex`, standalone script for install/update         | [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)                                          |
| Claude Code       | npm `@anthropic-ai/claude-code`, Homebrew cask `claude-code`, native script              | [Setup and removal](https://code.claude.com/docs/en/setup)                                     |
| OpenCode v2       | npm/Bun `@opencode/cli`, Homebrew `anomalyco/tap/opencode-v2`, script for install/update | [v2 installation](https://opencode.ai/v2/docs/), [v2 removal](https://opencode.ai/v2/docs/cli) |
| Pi                | npm `@earendil-works/pi-coding-agent` with `--ignore-scripts`                            | [Pi's README](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)            |
| Cursor            | SDK ships with ace; no CLI mutation                                                      | [Official SDK](https://cursor.com/docs/sdk/typescript)                                         |
| Antigravity       | Official ACP registry archive                                                            | [Official ACP integration](https://antigravity.google/docs/ide/extensions/zed)                 |
| Gemini ACP        | npm `@google/gemini-cli`, Homebrew `gemini-cli`                                          | [Installation](https://geminicli.com/docs/get-started/installation/)                           |
| Qwen ACP          | npm `@qwen-code/qwen-code`                                                               | [Deployment](https://qwenlm.github.io/qwen-code-docs/en/developers/development/deployment/)    |
| Claude ACP bridge | npm `@agentclientprotocol/claude-agent-acp`                                              | [Bridge README](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/README.md)   |
| Codex ACP bridge  | npm `@agentclientprotocol/codex-acp`                                                     | [Bridge README](https://github.com/agentclientprotocol/codex-acp/blob/main/README.md)          |
| Goose ACP         | Homebrew `block-goose-cli`                                                               | [Homebrew formula](https://formulae.brew.sh/formula/block-goose-cli)                           |
| Auggie ACP        | npm `@augmentcode/auggie`                                                                | [Official CLI page](https://www.augmentcode.com/product/cli)                                   |

Package removals use the managers' documented global removal commands: [npm uninstall](https://docs.npmjs.com/cli/v11/commands/npm-uninstall/), [Bun remove](https://bun.sh/docs/pm/cli/remove), and [Homebrew uninstall](https://docs.brew.sh/Manpage). Bun's OpenCode installation explicitly trusts the required postinstall script, as the vendor documents. Other lifecycle scripts remain the official package manager's responsibility. Claude's native removal deletes only its documented binary and version directory. Codex's standalone docs do not establish automatic removal. OpenCode v2's curl removal prints a manual executable-removal command. These script uninstall plans stay manual. Google's separate `agy` CLI installer does not establish installation or authentication of the `agy_acp_server` runtime ace uses, so substituting it would falsely report a usable installation. Custom ACP registry sources never extend this manifest allowlist. Official registry targets use the registry-owned distribution, digest validation and inventory. A successful install enrolls its verified binding. Registry versions remain available for existing conversations.

Every operation, including plans and polls, requires operate scope. One session per provider may mutate its installation at a time. The daemon rechecks the method at run time, logs the exact command and verified version, and supervises the process group through provider-kit. Scripts run with pipe failure propagation so a failed download cannot be mistaken for success. An unwritable destination returns a `needs_admin` session with the reviewed commands for an ace terminal tab. The daemon never executes sudo or supplies a password. The UI must ask the person before opening that terminal flow and refresh readiness afterward.

Progress is ephemeral. Sessions survive socket reconnects for the owning device, retain the last 100 sanitized lines of at most 2,048 characters, and coalesce output notifications. The daemon retains at most 32 sessions, rejects excess concurrent socket requests, bounds installer output to 16 MiB and each raw line to 64 KiB, and stops operations after 15 minutes. Cancel and shutdown abort probes and kill installer descendants before announcing completion. Restart does not resume a mutation or replay its commands. A person must plan again after an interrupted daemon; discovery reports what actually remains installed.

Success requires a usable `--version` result or verified disappearance on uninstall, followed by discovery refresh and model-catalog invalidation. Newly installed native providers reuse the existing adapter and default-model admission paths. Auth state stays independent of installation. Latest versions use `npm view <package> version` or `brew info --json=v2`; successful observations have a one-hour TTL, failures retry after five minutes and retain the last good value. No inference or credential probe is used for a version check. Unknown or prerelease latest versions do not claim a stable update is available.

The additive wire and UI handoff is in [provider CLI installation](../daemon/provider-install.md). Verification uses temporary homes, fake managers and real processes and sockets. It does not install real packages, record sessions or send provider prompts.

## Amendment: shared one-click provider setup

Accepted by the owner's 2026-10-08 request. Setup, Settings and registry detail use
one provider row and the existing installation/login controllers. Install plans
are prepared and rechecked by the local service when Install is pressed; the
reviewed source, commands and redacted log are available under Details. There is
one primary action: Install, Sign in or Update, with Retry after failure.

Official registry installs additionally require admin scope, matching registry
mutation admission. They use `method: registry` and `acpAgentId`, retain companion
archive files and bind the catalog entrypoint. Antigravity remains one built-in
provider rather than a duplicate registry row. Cursor uses the shipped SDK.
Missing Node/npm can be installed by existing Homebrew; otherwise its official
platform installer is explained. Missing uv uses Astral's official script in the
per-user binary directory. Homebrew's first setup may need administrator input,
so ace offers its official setup with that explanation. No sudo or password prompt
is run in the unattended installer. Native npm plans enforce reviewed Node minima.
A Get-provider fallback is reserved for a catalog distribution unavailable on the
host. Known installations preserve their existing installer ownership.
