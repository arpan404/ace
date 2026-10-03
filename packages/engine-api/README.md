# @ace/engine-api

Types shared by adapters, the daemon engine and the recorder. There is no runtime implementation here.

An adapter creates a synchronous translator and an I/O session. The translator owns provider knowledge and its small local state. It maps native frames to `@ace/core` facts; core allocates canonical IDs and derives status. `tick(now)` reports facts implied by elapsed time. The engine owns the clock, fact ordering, persistence and timers.

The session uses `@ace/provider-kit` to talk to the user's installed CLI and execute commands. It sends every native frame to `SessionContext.onFrame`, including outgoing frames, stderr, notes and unknown messages. The engine feeds them all through the translator. The session reports process exit through `onExit` and follows the engine's abort signal. It never decides status.

Translators never throw on provider data. Preserve unknown event types and fields as raw data rather than dropping them. Bracket all agents' work with turn facts, including synthesized child turns. Report surviving work as background tasks before ending a turn. Namespace native keys and turn IDs by provider process so resumed sessions cannot reuse an old identity accidentally. See [core's fact contract](../core/README.md) and [ADR 0007](../../docs/adr/0007-adapter-and-engine-contract.md).

Sessions without native steering queue input internally until the turn settles.

Forks use `SessionContext.fork`, exclusive with `resume`. Adapters opt in with
`capabilities.fork` and explicit `forkPoints`: `turn` and `item` are inclusive
native IDs; `end` copies the full session. Missing `forkPoints` means portable
fallback, even if an older adapter advertised a fork UI. `forkSubagents` allows
full-fidelity native subagent session references as fork sources. No boundary is
inferred from a process-namespaced or synthesized run ID.

`SessionContext.options` holds schema-validated provider options. Advertise
`sessionOptions` only when the adapter validates and applies them. Optional
`ProviderSession.configure(selection)` changes subsequent-turn model/options
without replacing the native session. Without it, the engine closes and resumes
the same native session, provided the adapter advertises resume.

The engine routes portable forks, including Cursor, and provider switches through
`@ace/context.portableContext`, backed by the public `@ace/handoff` policy.
It supplies a frozen cutoff/indexed count and installs scoped historical grants.

`send(input, delivery, commandId?)` includes optional engine command correlation. A provider with durable admission echoes it as `input.admitted.commandId` when the native input is accepted or reconciled. This transfers the exact engine intent to provider queue ownership; it does not create or finish a turn. Keep the correlation local to ace unless the provider contract requires it.
