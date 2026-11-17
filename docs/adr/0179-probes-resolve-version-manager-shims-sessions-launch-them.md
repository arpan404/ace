# 0179: Probes resolve version-manager shims; sessions launch them

Date: 2026-11-17. Status: accepted. Decided by: the owner (rule), the test-isolation work (design).

## Context

Many people install agent CLIs and their runtimes through a version manager: mise, asdf, volta
or proto. What sits on PATH is then a shim, a small program that picks the tool's version for
the current directory and runs it. Running a shim can do more than that: mise installs a `lazy`
tool on first use and updates an `auto_update` one before running it, proto installs on use, and
volta fetches a pinned Node it doesn't have.

ace runs provider CLIs in two ways that the person didn't directly ask for: probes (`--version`,
login status, `--help`) at startup and on a timer, and model discovery, which starts the CLI to
list its models. Through a shim, either one could download and install software. A test run
showed what that costs: with mise shims on PATH, each test home received about 5.5 GB of CLIs.

## Decision

**Probes and model discovery never run a shim.** Before running one, ace asks its manager which
installed binary it stands for (`mise which`, `asdf which`, `volta which`, `proto bin`), with
installing and network access turned off, a 3 s bound, and the directory the CLI will run in, so
a project's own version is the one resolved. ace then runs that binary. A tool the manager
reports as not installed is shown as not installed. A manager that fails, times out or answers
with another shim leaves the CLI found but unprobed, with the reason, and ace runs nothing.

The CLI's own interpreter gets the same rule: a script run by `#!/usr/bin/env node` reaches
`node` through PATH. A probe's PATH puts the resolved runtime's directory first and leaves out
shim directories, a shim named outright in a `#!` line is replaced by its binary, and every probe
carries the managers' no-install and offline settings for anything further down.

**Sessions launch the shim, deliberately.** When the person starts work with a provider, ace
runs the CLI exactly as their shell would, shim included:

- The shim is how the person chose to manage that tool. Its per-project versions, its
  wrappers (an account switcher, for example) and its updates are behaviour they configured and
  expect from every launch, ace's included.
- A session is the person's request to use the tool. An install or update the shim does then is
  the one they would get by typing the command themselves, not something ace started on its own.
- Running the resolved binary instead would bypass that setup and could run a different version
  than the one the person's shell runs in the same project.

## Consequences

- Provider status shows the same version and login a session will use, without installing.
- A lazy tool that was never installed shows as not installed until the person installs it.
- A manager ace can't query (not on PATH, too slow, unexpected output) leaves that CLI unprobed,
  and the person can set the provider's binary path to the installed executable.
- asdf, volta and proto queries follow their documented commands; only mise's was checked
  against an installed release (2026.11.1).
