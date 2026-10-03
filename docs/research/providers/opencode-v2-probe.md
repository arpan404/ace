# OpenCode 2.0.22 non-prompt probe

Observed 2026-10-02 with `/Users/arpanbhandari/.opencode/bin/opencode`.
This is protocol evidence, not a recorded model session. No session was created,
no prompt was sent, and no model turn was started. Each server was terminated
and awaited in the probe's `finally` block.

## Launch

`opencode serve --hostname 127.0.0.1 --port 0`, in a scratch directory, with a
random in-memory `OPENCODE_PASSWORD`, `OPENCODE_DB=:memory:`,
`OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, and
`OPENCODE_CONFIG_CONTENT={"plugin":[]}`. Requests used HTTP Basic with username
`opencode`. No password or authorization header was captured in the evidence.
The in-memory database kept this probe from migrating the user's database.
Readiness was `server listening on http://127.0.0.1:<ephemeral-port>`.

## HTTP results

All requests below were GETs. Rows were authenticated unless stated otherwise.

| Path                          | Status | Content type / result                                     |
| ----------------------------- | ------ | --------------------------------------------------------- |
| `/doc`                        | 200    | `text/html`, OpenCode web app                             |
| `/openapi.json`               | 200    | `application/json`, OpenAPI `3.1.0`, 140 operations       |
| `/api/info`                   | 200    | JSON `{version:"2.0.22", pid, urls, paths:{tmp}}`         |
| `/api/session/active`         | 200    | JSON `{"data":{}}`                                        |
| `/api/session?limit=1`        | 200    | JSON `{"data":[],"cursor":{"previous":null,"next":null}}` |
| `/global/health`              | 200    | `text/html`, OpenCode web app                             |
| `/global/event`               | 200    | `text/html`, OpenCode web app                             |
| `/session/status`             | 200    | `text/html`, OpenCode web app                             |
| `/api/health`                 | 404    | Empty body                                                |
| `/api/server/health`          | 404    | Empty body                                                |
| `/api/session/status`         | 400    | `InvalidRequestError`, `status` is not a session ID       |
| `/api/event`, unauthenticated | 401    | Authentication required                                   |
| `/api/event`, authenticated   | 200    | SSE, connected event then comment heartbeat               |

The raw `/openapi.json` SHA-256 was
`540fdf565da27de9df69b6c3864582344e74ac4ffa225c283b289481d215d241`.
Its `info.version` is `0.0.1`, not the CLI version. Its title is
`opencode HttpApi`; its description still calls the API experimental.

The SSE bytes, with the generated event ID replaced, were:

```text
data: {"id":"<event-id>","type":"server.connected","data":{}}

: heartbeat

```

There was no SSE `id:` or `retry:` field. The source's 15-second heartbeat
interval is in `packages/server/src/handlers/event.ts:EventHandler`, pinned to
[2.0.22 source](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/server/src/handlers/event.ts).
The OpenAPI registration moved to `/openapi.json` in
[`createRoutes`](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/server/src/routes.ts).
Raw local probe artifacts and the scratch probe script were saved under
`/tmp/ace-opencode-v2-research/probe/` and
`/tmp/ace-opencode-v2-research/probe.py`; these temporary files are not required
by the implementation.

## Installed version probes

These commands were version-only, with no sessions or inference:

| Command              | Output                  |
| -------------------- | ----------------------- |
| `codex --version`    | `codex-cli 0.159.1`     |
| `opencode --version` | `opencode v2.0.22`      |
| `agent --version`    | `2026.09.26-dd393fe`    |
| `claude --version`   | `2.1.286 (Claude Code)` |
| `gemini --version`   | `0.43.0`                |
| `qwen --version`     | `0.0.14`                |

`opencode --help`, `serve --help`, `api --help`, `service --help`,
`auth --help`, `debug --help`, and `debug paths` were also inspected. No
`auth export`, provider authentication operation, recorder, test suite, or
model-generating API was invoked.

## SDK attachment probe

A second GET-only probe attached the published `@opencode/client@2.0.22`
Promise root to an owned loopback `serve` process with an in-memory database.
It used a random `OPENCODE_PASSWORD`, disabled model-list fetch and project
config, and never printed or stored transport auth. It created no sessions
and sent no prompts.

| Client call                                    | Observed result                                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `client.server.info()`                         | 200 JSON from `/api/info`; version 2.0.22 and PID matched the owned process                                                  |
| `client.session.list({directory: scratchCwd})` | 200 JSON from `/api/session`; return object had `data` and `cursor` keys                                                     |
| `client.event.subscribe({signal,onActivity})`  | 200 SSE from `/api/event`; 16-second read yielded only `server.connected`, with three activity chunks; abort ended iteration |
| Legacy SDK/v2 `global.health()`                | 200 HTML from `/global/health`; client threw an unsupported-server-version error                                             |

Probe script and results are in
`/tmp/ace-opencode-sdk-research/sdk-probe.mjs` and `sdk-probe.json`. The child
was terminated after the probe. The client code inspected was the
[official current tarball](https://registry.npmjs.org/@opencode/client/-/client-2.0.22.tgz),
`dist/promise/index.js`, and
[legacy SDK tarball](https://registry.npmjs.org/@opencode-ai/sdk/-/sdk-1.18.34.tgz),
`dist/v2/client.js`.

Later help-only checks also confirmed `opencode models --help` has no
`--verbose` flag, and `opencode auth list --help` supports `--standalone`,
`--server` and `--format default|json`. Neither metadata command was executed
against the user's managed service.
