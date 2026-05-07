# ace CLI

The `ace` CLI is the control plane for the local ace runtime. It opens the web UI, manages the background daemon, checks provider readiness, controls telemetry, and exposes automation-friendly JSON output.

## Mental Model

- `ace web` is the normal entry point. It starts or reuses the daemon and opens the app.
- `ace serve` is for foreground/server-log workflows. It starts or attaches to the daemon and streams logs.
- `ace daemon ...` is explicit lifecycle control for scripts and troubleshooting.
- `ace stop` is the short form of `ace daemon stop`.
- `ace doctor` validates the local setup before you start debugging provider issues.
- `ace telemetry ...` controls the stored telemetry preference.
- `ace remote ...` manages remote pairing and relay-backed device access.

Most users should start with:

```bash
ace doctor
ace web .
```

## First Run

1. Install and sign in to at least one provider CLI.

```bash
codex login
claude auth login
cursor-agent --help
gemini --help
opencode --help
```

2. Check local readiness.

```bash
ace doctor
```

3. Open ace for the current workspace.

```bash
ace web .
```

4. If the daemon gets into a bad state, restart it.

```bash
ace daemon restart
```

## Common Tasks

Open ace:

```bash
ace web
ace web ~/Code/my-project
ace web . --no-browser
```

Run in a terminal and follow logs:

```bash
ace serve
ace serve . --port 4317
```

Check setup:

```bash
ace doctor
ace doctor --json
```

Stop the daemon:

```bash
ace stop
ace daemon stop
```

Control telemetry:

```bash
ace telemetry status
ace telemetry off
ace telemetry on
```

Inspect managed terminals:

```bash
ace terminal list
ace terminal stop <terminal-id>
```

Pair a remote device:

```bash
ace remote create --device-name "Work Mac"
ace remote list
ace remote ping --once
```

## Command Reference

### `ace web [workspace]`

Open the ace web app by reusing or starting the background daemon.

Use this for normal daily usage.

```bash
ace web
ace web .
ace web ~/Code/app --no-browser
```

Useful flags:

- `--telemetry on|off` overrides telemetry for this daemon-starting command.
- `--no-browser` starts/reuses the daemon without opening a browser.
- `--port <number>` chooses the daemon HTTP/WebSocket port.
- `--host <host>` chooses the daemon bind host.
- `--base-dir <path>` stores daemon state somewhere other than the default ace home.
- `--auth-token <token>` sets the local API auth token.
- `--relay-url <url>` points remote features at a custom relay.

### `ace serve [workspace]`

Run or attach to the persistent daemon and stream server logs.

Use this when developing ace itself, debugging startup, or running the server in a foreground process manager.

```bash
ace serve
ace serve . --host 127.0.0.1 --port 4317
```

Useful flags:

- `--telemetry on|off`
- `--port <number>`
- `--host <host>`
- `--base-dir <path>`
- `--relay-url <url>`

### `ace doctor`

Check local readiness without starting an agent session.

It reports:

- ace version and home/base directory.
- daemon status.
- stored telemetry preference.
- provider CLI availability for Codex, Claude, Cursor, Gemini, and OpenCode.

```bash
ace doctor
ace doctor --json
```

Use `--json` in scripts or bug reports when you need stable machine-readable output.

### `ace telemetry`

View or change the stored anonymous telemetry preference.

Telemetry is on by default for open-source product analytics. The identity model is anonymous by default and uses a local installation ID, not provider account details.

```bash
ace telemetry status
ace telemetry off
ace telemetry on
```

Root shortcuts:

```bash
ace --telemetry off
ace --telemetry on
```

One-run overrides for daemon-starting commands:

```bash
ace web --telemetry off
ace serve --telemetry off
ace daemon start --telemetry on
ace daemon restart --telemetry off
```

Environment override:

```bash
ACE_TELEMETRY_ENABLED=false ace web
```

Resolution order:

1. `--telemetry on|off`
2. `ACE_TELEMETRY_ENABLED`
3. stored preference from `ace telemetry on|off`
4. default: `on`

### `ace daemon`

Manage the background daemon explicitly.

```bash
ace daemon start
ace daemon status
ace daemon stop
ace daemon restart
```

Useful flags:

- `--json` prints machine-readable output.
- `--base-dir <path>` points at a non-default ace home.
- `--timeout-ms <number>` controls stop/restart wait time.
- `--telemetry on|off` applies to start/restart.

### `ace stop`

Stop the background daemon.

This is equivalent to `ace daemon stop`.

```bash
ace stop
ace stop --json
ace stop --timeout-ms 10000
```

### `ace terminal`

Inspect and stop terminals managed by ace.

```bash
ace terminal list
ace terminal list --json
ace terminal stop <terminal-id>
ace terminal stop <terminal-id> --json
```

Use this when a provider-spawned terminal or shell task is still running after a session ended.

### `ace project`

Manage saved projects.

```bash
ace project add <path> --title "API Server"
ace project list
ace project list --json
ace project remove <project>
ace project remove <project> --force
```

### `ace remote`

Manage remote pairing and relay-backed device access.

Create a pairing session:

```bash
ace remote create --device-name "Work Mac"
```

Link another device using a pairing token:

```bash
ace remote link --token "ace://pair?..."
```

Inspect and maintain remotes:

```bash
ace remote list
ace remote ping --once
ace remote revoke <session>
ace remote remove <remote>
ace remote remove all
```

Useful flags:

- `--json`
- `--interactive`
- `--relay-url <url>`

### `ace profile`

Show daemon subprocess and runtime resource stats.

```bash
ace profile
ace profile --json
ace profile --pid 12345 --interval-ms 1000
```

### `ace update`

Update the packaged desktop app.

```bash
ace update
```

### `ace interactive`

Open the interactive quick-action picker.

```bash
ace interactive
ace interactive --action web
```

## Telemetry And Privacy

Telemetry exists to answer product questions such as which providers are used, where sessions fail, and which CLI flows need improvement.

ace should not collect:

- prompt text
- file contents
- attachment contents
- auth tokens
- raw provider account IDs
- raw file paths or repository names

ace may collect:

- anonymous installation identity
- ace version, OS, architecture, and client type
- command/session lifecycle events
- provider name, model name, and runtime mode
- counts and booleans such as attachment count, rollback count, and provider distribution
- coarse performance/reliability stats such as latency buckets, retry count, and recovery strategy

Disable telemetry persistently:

```bash
ace telemetry off
```

Disable telemetry for one daemon-starting command:

```bash
ace web --telemetry off
```

Check current preference:

```bash
ace telemetry status
```

## Automation

Prefer `--json` for scripts.

```bash
ace daemon start --json
ace daemon status --json
ace doctor --json
ace project list --json
ace terminal list --json
ace stop --json
```

Use a separate base directory when running isolated CI or test jobs:

```bash
ACE_TELEMETRY_ENABLED=false ace daemon start --base-dir "$RUNNER_TEMP/ace" --json
ace doctor --base-dir "$RUNNER_TEMP/ace" --json
ace stop --base-dir "$RUNNER_TEMP/ace" --json
```

## Troubleshooting

`ace web` does not open the browser:

```bash
ace web --no-browser
ace daemon status
```

Provider is missing or not authenticated:

```bash
ace doctor
```

Daemon is stale or stuck:

```bash
ace daemon restart
```

Port is already in use:

```bash
ace web --port 4318
ace serve --port 4318
```

Telemetry state is unclear:

```bash
ace telemetry status
ACE_TELEMETRY_ENABLED=false ace doctor
```

Remote pairing does not connect:

```bash
ace remote list
ace remote ping --once
ace doctor
```

## Help And Completions

The CLI has curated help for the main workflows:

```bash
ace --help
ace web --help
ace serve --help
ace doctor --help
ace telemetry --help
ace daemon --help
ace stop --help
ace terminal --help
ace remote --help
```

Generate shell completions:

```bash
ace --completions zsh
ace --completions bash
ace --completions fish
```

## Legacy Compatibility

Older aliases may still work for compatibility, but new scripts and docs should prefer the explicit command forms:

- prefer `ace web` over `ace --web`
- prefer `ace daemon restart` over `ace --restart`
- prefer `ace stop` over ad hoc process cleanup
