# Daemon startup

Run source with `ACE_HOME=/path/to/private/home bun run --filter @ace/daemon dev`
or `ACE_HOME=/path/to/private/home bun run ace -- start`. The runtime is Node 24+.
The root package has no `daemon` or `dev` script.

The event store, authentication files and core service attempts open before the
listener. `services/composition.ts` declares the order. `requires` means a
successful dependency is necessary; `after` permits an optional dependency to
be degraded. Core services precede listener services, and the registry rejects
missing, forward or duplicate dependency declarations before starting anything.

The daemon writes its private `daemon-endpoint` file after the listener accepts
connections. Optional context, review, history, usage and notification startup
then runs. Existing socket handlers read the live registry as services become
available. Notification activation registers devices that connected during
startup, including clients that read the endpoint before notifications opened.

Each initialization and activation attempt has a 15-second backstop. Timeout
errors name the service. An attempt owns its resources and an abort signal, and
publishes its service objects only after initialization succeeds. Failure starts
cleanup, prevents late publication and leaves the daemon serving. An unavailable
engine rejects commands with `engine_unavailable`; it never manufactures a
successful result or a settled agent state. Store, lock, identity and bind failures
remain fatal, with resource cleanup and lock release.

Authenticated `GET /v1/status` adds a `services` list to the existing running,
version and remote fields. Each entry contains `name`, `state` and an optional
`error`; states are `starting`, `ready` and `degraded`. `ace status` exposes the
same report. This additive HTTP diagnostic does not change WebSocket schemas.

A service start must finish initialization, not await its lifetime subscription
or delivery loop. Notifications uses an explicit worker-ready acknowledgement
following SQLite initialization and RPC listener installation. Finite replay is
separate from delivery; transport acceptance is background work. An aborted
startup terminates an unresponsive notification worker and rejects queued RPCs.

Doctor resolves git from PATH first, then `/usr/bin/git` and `/bin/git` when PATH
has no installation. It accepts distribution suffixes such as
`git version 2.50.1 (Apple Git-155)`. An explicit broken PATH installation still
fails; it is not silently replaced with system git.
