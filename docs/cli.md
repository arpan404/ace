# ace CLI

Modern command reference for running ace locally and in automation.

## Command Model

- `ace <command> [flags]`
- `ace stop` is a top-level shortcut for `ace daemon stop`.
- `ace --help` and `ace <command> --help` show full generated help.

## Quick Start

```bash
# Open app in browser (reuses or starts daemon)
ace web

# Check daemon, telemetry, and provider CLI readiness
ace doctor

# Attach to daemon logs; starts daemon if missing
ace serve

# Start/stop/restart daemon explicitly
ace daemon start
ace stop
ace daemon restart
```

## Telemetry

Telemetry is **on by default**.

You can persistently control the default:

```bash
ace telemetry status
ace telemetry off
ace telemetry on
```

You can also override it for a single server-starting command:

```bash
ace web --telemetry off
ace daemon start --telemetry off
ace daemon restart --telemetry on
```

You can also set an environment override:

```bash
ACE_TELEMETRY_ENABLED=false ace web
```

Resolution order:

1. `--telemetry on|off`
2. `ACE_TELEMETRY_ENABLED`
3. stored preference from `ace telemetry on|off`
4. default: `on`

## Core Commands

### `ace web`

Open the ace web app by reusing or starting the background daemon.

Useful flags:

- `--telemetry on|off`
- `--no-browser`
- `--port <number>`
- `--host <host>`
- `--base-dir <path>`
- `--auth-token <token>`
- `--relay-url <url>`

### `ace serve`

Run or attach to the persistent background daemon and stream logs.

Useful flags:

- `--telemetry on|off`
- `--port <number>`
- `--host <host>`
- `--base-dir <path>`
- `--relay-url <url>`

### `ace doctor`

Check local readiness without starting an agent session.

It reports:

- ace version and base directory
- daemon status
- stored telemetry preference
- provider CLI availability for Codex, Claude, Cursor, Gemini, and OpenCode

Examples:

```bash
ace doctor
ace doctor --json
```

### `ace telemetry`

View or change the stored anonymous telemetry preference.

- `ace telemetry status`
- `ace telemetry on`
- `ace telemetry off`

Shortcut:

```bash
ace --telemetry off
ace --telemetry on
```

### `ace daemon`

Daemon lifecycle management.

- `ace daemon start` start background daemon (idempotent)
- `ace daemon status` print daemon status
- `ace daemon stop` stop daemon gracefully
- `ace daemon restart` restart daemon process

Common flags:

- `--base-dir <path>`
- `--timeout-ms <number>` (stop/restart)
- `--json`
- `--telemetry on|off` (start/restart)

### `ace stop`

Top-level alias for `ace daemon stop` with the same flags.

### `ace profile`

Live process/resource profiler for daemon subprocesses and runtime stats.

Examples:

```bash
ace profile
ace profile --json
ace profile --pid 12345 --interval-ms 1000
```

### `ace update`

Update the packaged desktop app.

## Project Commands

- `ace project add <path> [--title "..."]`
- `ace project list`
- `ace project remove <project> [--force]`

Use `--json` for machine-readable output.

## Remote Commands

- `ace remote create --device-name "My Mac"`
- `ace remote list`
- `ace remote revoke [session]`
- `ace remote link --token "<ace://pair?...>"`
- `ace remote remove [remote|all]`
- `ace remote ping [remote|all] [--once]`

Useful flags:

- `--json`
- `--interactive`
- `--relay-url <url>`

## Interactive Mode

Use quick-action picker:

```bash
ace interactive
ace interactive --action web
```

## Output Modes

- default: human-readable output
- `--json`: structured output for scripts/automation (supported by many subcommands)

## Examples for CI/Automation

```bash
# Ensure daemon is up
ace daemon start --json

# Query daemon status
ace daemon status --json

# Stop daemon at job end
ace stop --json
```
