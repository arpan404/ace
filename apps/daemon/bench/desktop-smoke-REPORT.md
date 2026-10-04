# Packaged desktop daemon investigation

Measured on darwin-arm64 using the production esbuild bundler and its independently
bundled helpers from `tools/release`, with the shipped Node 24.13.0. No desktop or
release source was changed. Each run used a new temporary home, no model/history
instances, and no provider prompts. Raw results are in
[desktop-smoke-results.json](desktop-smoke-results.json); worker paths are shortened
and temporary-home paths are omitted.

| Entry                                             | Runtime | RSS at 10 s, MiB | RSS at 60 s, MiB |
| ------------------------------------------------- | ------- | ---------------: | ---------------: |
| Scripted benchmark, source before fixes           | 24.13.0 |           341.55 |           281.61 |
| Scripted benchmark, release bundle before fixes   | 24.13.0 |           226.17 |           196.69 |
| Actual release CLI, fixes applied                 | 24.13.0 |           228.80 |           199.33 |
| Actual release CLI, repeat after shutdown changes | 24.13.0 |           229.56 |           200.36 |
| Actual source CLI                                 | 24.13.0 |           354.20 |           292.58 |
| Actual source CLI, installed runtime comparison   | 26.8.1  |           352.50 |           352.69 |

MiB means 1,048,576 bytes. The final repeated release sample is 210.09 MB in decimal
units. These results do not reproduce the owner's 264 MB packaged versus 199 MB
source observation, and they do not establish a memory reduction from these fixes.
No speculative allocator, worker or SQLite tuning was added.

The scripted entry and actual CLI differ: the release CLI includes the updater,
service commands and default preview gateway, while the scripted benchmark supplies
its own handler and IPC workload. Their one-minute bundled RSS differs by about
3 MiB here. The source entries run Node's TypeScript loader and unbundled imports;
the bundle is minified JavaScript. At 60 seconds on Node 24.13.0, the actual CLI's
main heap is 58.4 MiB bundled versus 74.9 MiB from source; its notification-worker
heap is 10.2 versus 24.5 MiB. RSS also includes native/allocator and compiled-code
pages, so these heap numbers do not fully explain the RSS difference.

Both entries retain one notification worker and briefly start the usage worker at
the minute boundary. The observer can report a retired worker for 1.5 seconds;
these worker counts are recent telemetry, not proof of permanent extra workers.
The same SQLite settings apply in both modes: the event store has a 2 MiB page
cache, notifications 512 KiB, usage 1 MiB, mmap is disabled, and the event store's
prepared-statement cache holds at most 256 entries. There is no bundle-specific
SQLite cache setting. These isolated runs cannot explain memory caused by the
owner's populated home, desktop supervision or a different staged build.

The existing benchmark now supports the real CLI without sending scripted IPC or
starting provider sessions:

```sh
node apps/daemon/bench/compile.ts --cli --runtime --output=.ace-dev/smoke-release
node apps/daemon/bench/measure.ts --idle-only --entry=.ace-dev/smoke-release/ace.mjs --node=.ace-dev/smoke-release/bin/node --output=.ace-dev/smoke-release-idle.json
node apps/daemon/bench/measure.ts --idle-only --entry=apps/daemon/src/cli.ts --node=.ace-dev/smoke-release/bin/node --output=.ace-dev/smoke-source-idle.json
```

Idle-only runs stop with SIGTERM after the idle samples. Both measured fixed release
runs exited normally with empty stderr, including all SQLite worker isolates.
The one-minute runs include the telemetry observer's half-second file writes.
Startup timing was noisy while checks shared the host and is not used as a claimed
performance improvement.
