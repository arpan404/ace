# @ace/engine-api

Types shared by adapters, the daemon engine and the recorder. There is no runtime implementation here.

An adapter creates a synchronous translator and an I/O session. The translator owns provider knowledge and its small local state. It maps native frames to `@ace/core` facts; core allocates canonical IDs and derives status. `tick(now)` reports facts implied by elapsed time. The engine owns the clock, fact ordering, persistence and timers.

The session uses `@ace/provider-kit` to talk to the user's installed CLI and execute commands. It sends every native frame to `SessionContext.onFrame`, including outgoing frames, stderr, notes and unknown messages. The engine feeds them all through the translator. The session reports process exit through `onExit` and follows the engine's abort signal. It never decides status.

Translators never throw on provider data. Preserve unknown event types and fields as raw data rather than dropping them. Bracket all agents' work with turn facts, including synthesized child turns. Report surviving work as background tasks before ending a turn. Namespace native keys and turn IDs by provider process so resumed sessions cannot reuse an old identity accidentally. See [core's fact contract](../core/README.md) and [ADR 0007](../../docs/adr/0007-adapter-and-engine-contract.md).

Sessions without native steering queue input internally until the turn settles.

`send(input, delivery, commandId?)` includes optional engine command correlation. A provider with durable admission echoes it as `input.admitted.commandId` when the native input is accepted or reconciled. This transfers the exact engine intent to provider queue ownership; it does not create or finish a turn. Keep the correlation local to ace unless the provider contract requires it.
